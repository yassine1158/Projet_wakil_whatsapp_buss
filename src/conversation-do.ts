import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import type { Effort } from "./agent";
import { loadCatalog } from "./catalog";
import {
  addIncoming,
  appendLog,
  enqueueMessage,
  pauseAssistant,
  processPending,
  resumeAssistant,
  type EngineDeps,
  type InboxReporter,
} from "./engine";
import { conversationKey, INBOX_NAME } from "./names";
import { getTenant } from "./tenants";
import { workersAiTranscriber } from "./transcribe";
import type { ConversationMeta, Env, IncomingMessage, LogEntry, Tenant } from "./types";
import { WhatsAppClient, WhatsAppError } from "./whatsapp";

export type WebReply = { type: "text"; text: string } | { type: "image"; url: string; caption?: string };

export interface Transcript {
  meta: ConversationMeta | null;
  log: LogEntry[];
  handoffUntil: number;
}

/** Messages par jour et par visiteur du chat web, pour borner le coût d'un abus. */
const WEB_DAILY_LIMIT = 60;
/** Une conversation web sans activité pendant 30 jours est effacée. */
const WEB_TTL_MS = 30 * 24 * 3_600_000;
/** Code Meta : le client n'a pas écrit depuis plus de 24 h. */
const WINDOW_CLOSED = 131047;

export const WEB_LIMIT_REPLY =
  "Vous avez atteint la limite de messages pour aujourd'hui. Pour continuer, contactez-nous par téléphone ou sur WhatsApp.";

/**
 * Une conversation = un client chez une entreprise (un numéro WhatsApp, ou une session
 * du chat web). Le Durable Object garantit que ses messages sont traités dans l'ordre.
 */
export class ConversationDO extends DurableObject<Env> {
  async enqueue(phoneNumberId: string, message: IncomingMessage): Promise<boolean> {
    const debounce = Number(this.env.DEBOUNCE_MS ?? 4000);
    return enqueueMessage(this.ctx.storage, phoneNumberId, message, Date.now(), debounce);
  }

  /** Chat du site web (ou essai depuis l'application) : traite le message et renvoie les réponses. */
  async chat(phoneNumberId: string, sessionId: string, text: string, options: { test?: boolean } = {}): Promise<WebReply[]> {
    const tenant = getTenant(phoneNumberId);
    if (!tenant) return [];
    const storage = this.ctx.storage;
    const now = Date.now();

    const day = new Date(now).toISOString().slice(0, 10);
    const quota = await storage.get<{ day: string; count: number }>("webQuota");
    const count = quota?.day === day ? quota.count : 0;
    if (count >= WEB_DAILY_LIMIT) return [{ type: "text", text: WEB_LIMIT_REPLY }];
    await storage.put("webQuota", { day, count: count + 1 });

    const meta: ConversationMeta = { channel: "web", phoneNumberId, customerId: sessionId, test: options.test };
    const message: IncomingMessage = {
      id: crypto.randomUUID(),
      from: sessionId,
      timestamp: now,
      kind: "text",
      text,
      rawType: "text",
    };
    await addIncoming(storage, meta, message);

    const replies: WebReply[] = [];
    await processPending({
      ...this.engineDeps(tenant, phoneNumberId),
      sink: {
        sendText: async (t) => void replies.push({ type: "text", text: t }),
        sendImage: async (url, caption) => void replies.push({ type: "image", url, caption }),
      },
    });
    await storage.setAlarm(now + WEB_TTL_MS);
    return replies;
  }

  /** Fil de la conversation, pour l'application. */
  async transcript(): Promise<Transcript> {
    const storage = this.ctx.storage;
    return {
      meta: (await storage.get<ConversationMeta>("meta")) ?? null,
      log: (await storage.get<LogEntry[]>("log")) ?? [],
      handoffUntil: (await storage.get<number>("handoffUntil")) ?? 0,
    };
  }

  /**
   * Réponse écrite par l'équipe depuis l'application. Elle part sur WhatsApp, et
   * l'assistant se met en retrait pour laisser l'équipe continuer.
   */
  async teamReply(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const storage = this.ctx.storage;
    const meta = await storage.get<ConversationMeta>("meta");
    const tenant = meta && getTenant(meta.phoneNumberId);
    if (!meta || !tenant) return { ok: false, error: "not_found" };
    if (meta.channel !== "whatsapp") return { ok: false, error: "web_channel" };
    try {
      await this.whatsapp(meta.phoneNumberId).sendText(meta.customerId, text);
    } catch (err) {
      const closed = err instanceof WhatsAppError && err.code === WINDOW_CLOSED;
      return { ok: false, error: closed ? "window_closed" : "send_failed" };
    }
    const now = Date.now();
    // Gardé dans l'historique pour que l'assistant sache ce que l'équipe a répondu.
    const history = (await storage.get<Anthropic.Beta.BetaMessageParam[]>("history")) ?? [];
    if (history.length) {
      await storage.put("history", [
        ...history,
        { role: "assistant", content: [{ type: "text", text: `[Message de l'équipe] ${text}` }] },
      ]);
    }
    await appendLog(storage, [{ from: "equipe", text, at: now }]);
    await pauseAssistant(storage, now + (tenant.handoffHours ?? 12) * 3_600_000);
    await this.reporter(tenant).conversation({ meta, lastText: text, lastFrom: "equipe", at: now, status: "equipe" });
    return { ok: true };
  }

  async pause(hours: number): Promise<void> {
    await pauseAssistant(this.ctx.storage, Date.now() + hours * 3_600_000);
    await this.reportStatus("equipe");
  }

  async resume(): Promise<void> {
    await resumeAssistant(this.ctx.storage);
    await this.reportStatus("wakil");
  }

  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<ConversationMeta>("meta");
    // Sur le web, l'alarme ne sert qu'à effacer une conversation abandonnée.
    if (meta?.channel === "web") {
      await this.ctx.storage.deleteAll();
      return;
    }
    const tenant = meta && getTenant(meta.phoneNumberId);
    if (!tenant) return;
    try {
      await processPending(this.engineDeps(tenant, meta.phoneNumberId));
    } catch (err) {
      // Ne pas relancer l'alarme : une nouvelle tentative renverrait des messages en double.
      console.error("Traitement de la conversation échoué", err);
    }
  }

  private async reportStatus(status: "wakil" | "equipe") {
    const meta = await this.ctx.storage.get<ConversationMeta>("meta");
    const tenant = meta && getTenant(meta.phoneNumberId);
    if (!meta || !tenant) return;
    await this.inbox().setConversationStatus(conversationKey(meta, tenant.id), status);
  }

  private inbox() {
    return this.env.INBOX.get(this.env.INBOX.idFromName(INBOX_NAME));
  }

  private whatsapp(phoneNumberId: string) {
    return new WhatsAppClient(this.env.WHATSAPP_TOKEN, phoneNumberId, this.env.GRAPH_API_VERSION);
  }

  private reporter(tenant: Tenant): InboxReporter {
    return {
      conversation: async ({ meta, lastText, lastFrom, at, status }) => {
        await this.inbox().touchConversation({
          key: conversationKey(meta, tenant.id),
          tenant: tenant.id,
          channel: meta.channel,
          customerId: meta.customerId,
          name: meta.customerName ?? null,
          phone: meta.customerPhone ?? null,
          lastText,
          lastFrom,
          lastAt: at,
          status,
          test: !!meta.test,
        });
      },
      order: async (order) => {
        const meta = await this.ctx.storage.get<ConversationMeta>("meta");
        await this.inbox().addOrder({
          ...order,
          tenant: tenant.id,
          conversationKey: meta ? conversationKey(meta, tenant.id) : "",
          status: "nouvelle",
        });
      },
    };
  }

  private engineDeps(tenant: Tenant, phoneNumberId: string): EngineDeps {
    return {
      storage: this.ctx.storage,
      tenant,
      whatsapp: this.whatsapp(phoneNumberId),
      claude: new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY, baseURL: this.env.ANTHROPIC_BASE_URL || undefined }),
      agentConfig: {
        model: this.env.CLAUDE_MODEL ?? "claude-opus-5-5",
        effort: (this.env.CLAUDE_EFFORT ?? "low") as Effort,
      },
      transcribe: workersAiTranscriber(this.env.AI),
      loadCatalog: () => loadCatalog(tenant),
      now: Date.now,
      inbox: this.reporter(tenant),
    };
  }
}
