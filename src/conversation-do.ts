import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import type { Effort } from "./agent";
import { loadCatalog } from "./catalog";
import { enqueueMessage, pauseAssistant, processPending, resumeAssistant } from "./engine";
import { getTenant } from "./tenants";
import { workersAiTranscriber } from "./transcribe";
import type { Env, IncomingMessage } from "./types";
import { WhatsAppClient } from "./whatsapp";

/**
 * Une conversation = un client chez une entreprise. Le Durable Object garantit que les
 * messages d'un même client sont traités un par un, dans l'ordre.
 */
export class ConversationDO extends DurableObject<Env> {
  async enqueue(phoneNumberId: string, message: IncomingMessage): Promise<boolean> {
    const debounce = Number(this.env.DEBOUNCE_MS ?? 4000);
    return enqueueMessage(this.ctx.storage, phoneNumberId, message, Date.now(), debounce);
  }

  async pause(hours: number): Promise<void> {
    await pauseAssistant(this.ctx.storage, Date.now() + hours * 3_600_000);
  }

  async resume(): Promise<void> {
    await resumeAssistant(this.ctx.storage);
  }

  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<{ phoneNumberId: string }>("meta");
    const tenant = meta && getTenant(meta.phoneNumberId);
    if (!tenant) return;
    try {
      await processPending({
        storage: this.ctx.storage,
        tenant,
        whatsapp: new WhatsAppClient(this.env.WHATSAPP_TOKEN, meta.phoneNumberId, this.env.GRAPH_API_VERSION),
        claude: new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }),
        agentConfig: {
          model: this.env.CLAUDE_MODEL ?? "claude-opus-5-5",
          effort: (this.env.CLAUDE_EFFORT ?? "low") as Effort,
        },
        transcribe: workersAiTranscriber(this.env.AI),
        loadCatalog: () => loadCatalog(tenant),
        now: Date.now,
      });
    } catch (err) {
      // Ne pas relancer l'alarme : une nouvelle tentative renverrait des messages en double.
      console.error("Traitement de la conversation échoué", err);
    }
  }
}
