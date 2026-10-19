import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type AgentConfig, type ClaudeClient } from "./agent";
import { sanitizeHistory, trimHistory } from "./history";
import { buildSystemPrompt, buildTurnContext } from "./prompt";
import type { ToolContext } from "./tools";
import type { Transcriber } from "./transcribe";
import type { Catalog, IncomingMessage, Order, Tenant } from "./types";
import { bytesToBase64 } from "./encoding";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;

/** Sous-ensemble du stockage d'un Durable Object utilisé ici (remplaçable en test). */
export interface ConversationStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
  sendImage(to: string, link: string, caption?: string): Promise<void>;
  sendTemplate(to: string, name: string, language: string, bodyParams: string[]): Promise<void>;
  markReadWithTyping(messageId: string): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

interface Meta {
  phoneNumberId: string;
  customerPhone: string;
  customerName?: string;
}

const MAX_SEEN = 100;
const MAX_ORDERS = 50;
/** Délai maximal d'attente avant de répondre quand le client enchaîne les messages. */
const MAX_WAIT_MS = 15_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const TECHNICAL_ISSUE_REPLY =
  "Désolé, j'ai un petit souci technique. Un conseiller de l'équipe va vous recontacter très vite.";

/**
 * Met un message en file d'attente. La réponse part après `debounceMs` sans nouveau
 * message (au plus MAX_WAIT_MS après le premier), pour répondre une seule fois à un
 * client qui envoie plusieurs messages d'affilée. Renvoie false pour un doublon.
 */
export async function enqueueMessage(
  storage: ConversationStorage,
  phoneNumberId: string,
  message: IncomingMessage,
  now: number,
  debounceMs: number,
): Promise<boolean> {
  const seen = (await storage.get<string[]>("seen")) ?? [];
  if (seen.includes(message.id)) return false;
  await storage.put("seen", [...seen, message.id].slice(-MAX_SEEN));

  const meta = (await storage.get<Meta>("meta")) ?? { phoneNumberId, customerPhone: message.from };
  if (message.name) meta.customerName = message.name;
  await storage.put("meta", meta);

  const pending = (await storage.get<IncomingMessage[]>("pending")) ?? [];
  pending.push(message);
  await storage.put("pending", pending);

  let firstAt = await storage.get<number>("firstPendingAt");
  if (firstAt === undefined) {
    firstAt = now;
    await storage.put("firstPendingAt", firstAt);
  }
  await storage.setAlarm(Math.min(now + debounceMs, firstAt + MAX_WAIT_MS));
  return true;
}

export async function pauseAssistant(storage: ConversationStorage, until: number) {
  await storage.put("handoffUntil", until);
}

export async function resumeAssistant(storage: ConversationStorage) {
  await storage.delete("handoffUntil");
}

export interface EngineDeps {
  storage: ConversationStorage;
  tenant: Tenant;
  whatsapp: WhatsAppSender;
  claude: ClaudeClient;
  agentConfig: AgentConfig;
  transcribe: Transcriber;
  loadCatalog: () => Promise<Catalog>;
  now: () => number;
  log?: (message: string, err?: unknown) => void;
}

/** Traite les messages en attente : comprend, répond, enregistre. Appelé par l'alarme. */
export async function processPending(deps: EngineDeps): Promise<void> {
  const { storage, tenant, whatsapp } = deps;
  const log = deps.log ?? ((m, e) => console.error(m, e ?? ""));

  const pending = (await storage.get<IncomingMessage[]>("pending")) ?? [];
  const meta = await storage.get<Meta>("meta");
  await storage.delete("pending");
  await storage.delete("firstPendingAt");
  if (!pending.length || !meta) return;

  const customer = meta.customerPhone;
  const now = deps.now();
  const history = (await storage.get<MessageParam[]>("history")) ?? [];
  const notifyOwner = (text: string) => sendToOwner(deps, text).catch((e) => log("Notification patron échouée", e));

  let catalog: Catalog | undefined;
  try {
    catalog = await deps.loadCatalog();
  } catch (err) {
    log("Chargement du catalogue échoué", err);
  }
  const hint = catalog ? catalog.products.map((p) => p.name).join(", ") : "";
  const blocks: BlockParam[] = [];
  for (const m of pending) blocks.push(...(await toContentBlocks(m, whatsapp, deps.transcribe, hint, log)));

  // Conversation confiée à un conseiller : l'assistant se tait et fait suivre au patron.
  const handoffUntil = (await storage.get<number>("handoffUntil")) ?? 0;
  if (now < handoffUntil) {
    await notifyOwner(
      `💬 Nouveau message de ${who(meta)} (conversation suivie par un conseiller) :\n${blocksToText(blocks)}\n${waLink(customer)}`,
    );
    await saveHistory(storage, [...history, { role: "user", content: blocks }]);
    return;
  }

  await whatsapp.markReadWithTyping(pending[pending.length - 1].id).catch((e) => log("Accusé de lecture échoué", e));

  if (!catalog) {
    await whatsapp.sendText(customer, TECHNICAL_ISSUE_REPLY).catch((e) => log("Envoi échoué", e));
    await notifyOwner(`⚠️ Wakil n'a pas pu charger le catalogue. Message de ${who(meta)} :\n${blocksToText(blocks)}\n${waLink(customer)}`);
    await saveHistory(storage, [...history, { role: "user", content: blocks }]);
    return;
  }

  const userContent: BlockParam[] = [
    { type: "text", text: buildTurnContext(tenant, customer, meta.customerName, now) },
    ...blocks,
  ];

  const toolContext: ToolContext = {
    catalog,
    customerPhone: customer,
    sendImage: (link, caption) => whatsapp.sendImage(customer, link, caption),
    saveOrder: async (data) => {
      const order: Order = {
        ...data,
        reference: `W-${now.toString(36).toUpperCase().slice(-6)}`,
        createdAt: now,
        customerPhone: customer,
      };
      const orders = (await storage.get<Order[]>("orders")) ?? [];
      await storage.put("orders", [...orders, order].slice(-MAX_ORDERS));
      await notifyOwner(formatOrderForOwner(order));
      return order;
    },
    requestHuman: async (reason, summary) => {
      await pauseAssistant(storage, now + (tenant.handoffHours ?? 12) * 3_600_000);
      await notifyOwner(
        `🙋 Un client demande un conseiller\nClient : ${who(meta)}\nMotif : ${reason}\nRésumé : ${summary}\nRépondre : ${waLink(customer)}\nPour réactiver l'assistant : #reprendre ${customer}`,
      );
    },
  };

  let result;
  try {
    result = await runAgent(
      deps.claude,
      deps.agentConfig,
      buildSystemPrompt(tenant, catalog),
      history,
      userContent,
      toolContext,
    );
  } catch (err) {
    log("Appel à Claude échoué", err);
    await whatsapp.sendText(customer, TECHNICAL_ISSUE_REPLY).catch((e) => log("Envoi échoué", e));
    await notifyOwner(`⚠️ Wakil n'a pas pu répondre à ${who(meta)} :\n${blocksToText(blocks)}\n${waLink(customer)}`);
    await saveHistory(storage, [...history, { role: "user", content: blocks }]);
    return;
  }

  const replies = result.replies.length ? result.replies : [TECHNICAL_ISSUE_REPLY];
  for (const reply of replies) {
    await whatsapp.sendText(customer, reply).catch((e) => log("Envoi de la réponse échoué", e));
  }
  await saveHistory(storage, [...history, ...result.newMessages]);
}

async function saveHistory(storage: ConversationStorage, messages: MessageParam[]) {
  await storage.put("history", trimHistory(sanitizeHistory(messages)));
}

async function toContentBlocks(
  m: IncomingMessage,
  whatsapp: WhatsAppSender,
  transcribe: Transcriber,
  hint: string,
  log: (message: string, err?: unknown) => void,
): Promise<BlockParam[]> {
  switch (m.kind) {
    case "text":
      return m.text?.trim() ? [{ type: "text", text: m.text }] : [];
    case "audio": {
      try {
        const media = await whatsapp.downloadMedia(m.mediaId ?? "");
        const text = await transcribe(media.bytes, media.mimeType, hint);
        if (text) return [{ type: "text", text: `[Message vocal, transcription automatique] ${text}` }];
      } catch (err) {
        log("Transcription échouée", err);
      }
      return [{ type: "text", text: "[Message vocal impossible à comprendre : demande au client de répéter ou d'écrire]" }];
    }
    case "image": {
      const caption: BlockParam[] = m.text?.trim() ? [{ type: "text", text: m.text }] : [];
      try {
        const media = await whatsapp.downloadMedia(m.mediaId ?? "");
        const type = media.mimeType.split(";")[0].trim();
        if (IMAGE_TYPES.has(type)) {
          return [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: bytesToBase64(media.bytes),
              },
            },
            ...caption,
          ];
        }
      } catch (err) {
        log("Téléchargement de la photo échoué", err);
      }
      return [{ type: "text", text: "[Photo reçue mais illisible]" }, ...caption];
    }
    case "location": {
      const l = m.location!;
      const label = [l.name, l.address].filter(Boolean).join(", ");
      return [
        {
          type: "text",
          text: `[Position partagée par le client] ${label} https://maps.google.com/?q=${l.latitude},${l.longitude}`.trim(),
        },
      ];
    }
    default:
      return [
        {
          type: "text",
          text: `[Le client a envoyé un message de type "${m.rawType}", non pris en charge : propose-lui d'écrire ou d'envoyer un vocal]`,
        },
      ];
  }
}

function blocksToText(blocks: BlockParam[]): string {
  return blocks.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[Photo]" : "")).filter(Boolean).join("\n");
}

function who(meta: Meta): string {
  return meta.customerName ? `${meta.customerName} (+${meta.customerPhone})` : `+${meta.customerPhone}`;
}

function waLink(phone: string): string {
  return `https://wa.me/${phone}`;
}

export function formatOrderForOwner(order: Order): string {
  const lines = [
    `🛒 Nouvelle demande Wakil · Réf ${order.reference}`,
    `Client : ${order.customerName} (+${order.customerPhone})`,
    ...order.items.map((i) => `• ${i.productName} : ${i.quantity} ${i.unit}${i.quantity > 1 ? "s" : ""}`),
    order.fulfilment === "livraison" ? `Livraison : ${order.deliveryLocation}` : "Enlèvement sur site",
  ];
  if (order.desiredDate) lines.push(`Date souhaitée : ${order.desiredDate}`);
  if (order.notes) lines.push(`Notes : ${order.notes}`);
  lines.push(`Répondre : ${waLink(order.customerPhone)}`);
  return lines.join("\n");
}

/**
 * Prévient le patron. Avec un modèle approuvé (ownerNotifyTemplate), le message passe
 * même hors de la fenêtre de 24 h ; les variables d'un modèle ne peuvent pas contenir
 * de saut de ligne, d'où la mise sur une ligne.
 */
async function sendToOwner(deps: EngineDeps, text: string) {
  const { tenant, whatsapp } = deps;
  const template = tenant.ownerNotifyTemplate;
  if (!template) return whatsapp.sendText(tenant.ownerPhone, text);
  const oneLine = text.replace(/\s*\n\s*/g, " | ").replace(/\s{2,}/g, " ").slice(0, 1000);
  return whatsapp.sendTemplate(tenant.ownerPhone, template.name, template.language, [oneLine]);
}
