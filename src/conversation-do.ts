import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import type { Effort } from "./agent";
import { loadCatalog } from "./catalog";
import {
  addIncoming,
  enqueueMessage,
  pauseAssistant,
  processPending,
  resumeAssistant,
  type EngineDeps,
} from "./engine";
import type { Lead } from "./leads";
import { getTenant } from "./tenants";
import { workersAiTranscriber } from "./transcribe";
import type { ConversationMeta, Env, IncomingMessage, Tenant } from "./types";
import { WhatsAppClient } from "./whatsapp";

export type WebReply = { type: "text"; text: string } | { type: "image"; url: string; caption?: string };

/** Messages par jour et par visiteur du chat web, pour borner le coût d'un abus. */
const WEB_DAILY_LIMIT = 60;
/** Une conversation web sans activité pendant 30 jours est effacée. */
const WEB_TTL_MS = 30 * 24 * 3_600_000;

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

  /** Chat du site web : traite le message tout de suite et renvoie les réponses. */
  async chat(phoneNumberId: string, sessionId: string, text: string): Promise<WebReply[]> {
    const tenant = getTenant(phoneNumberId);
    if (!tenant) return [];
    const storage = this.ctx.storage;
    const now = Date.now();

    const day = new Date(now).toISOString().slice(0, 10);
    const quota = await storage.get<{ day: string; count: number }>("webQuota");
    const count = quota?.day === day ? quota.count : 0;
    if (count >= WEB_DAILY_LIMIT) return [{ type: "text", text: WEB_LIMIT_REPLY }];
    await storage.put("webQuota", { day, count: count + 1 });

    const meta: ConversationMeta = { channel: "web", phoneNumberId, customerId: sessionId };
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

  /** Utilisé par l'instance "wakil:leads" : garde les demandes du formulaire du site de Wakil. */
  async saveLead(lead: Lead): Promise<void> {
    const leads = (await this.ctx.storage.get<Lead[]>("leads")) ?? [];
    await this.ctx.storage.put("leads", [...leads, lead].slice(-500));
  }

  async pause(hours: number): Promise<void> {
    await pauseAssistant(this.ctx.storage, Date.now() + hours * 3_600_000);
  }

  async resume(): Promise<void> {
    await resumeAssistant(this.ctx.storage);
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

  private engineDeps(tenant: Tenant, phoneNumberId: string): EngineDeps {
    return {
      storage: this.ctx.storage,
      tenant,
      whatsapp: new WhatsAppClient(this.env.WHATSAPP_TOKEN, phoneNumberId, this.env.GRAPH_API_VERSION),
      claude: new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }),
      agentConfig: {
        model: this.env.CLAUDE_MODEL ?? "claude-opus-5-5",
        effort: (this.env.CLAUDE_EFFORT ?? "low") as Effort,
      },
      transcribe: workersAiTranscriber(this.env.AI),
      loadCatalog: () => loadCatalog(tenant),
      now: Date.now,
    };
  }
}
