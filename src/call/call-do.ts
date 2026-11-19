import { DurableObject } from "cloudflare:workers";
import { loadCatalog } from "../catalog";
import { webConversation } from "../names";
import { tenantById } from "../registry";
import { speakerFor } from "../speech";
import type { Env } from "../types";
import { VOICE_PREFIX } from "../voice";
import { binaryMessage } from "./audio";
import { callTranscriber } from "./stt";
import { CallSession, type ClientMessage, type ServerMessage } from "./session";

/** Un appel ne dure pas plus de 10 minutes. */
export const MAX_CALL_MS = 10 * 60_000;

/**
 * Salle d'un appel en direct : tient le WebSocket ouvert avec le navigateur et fait tourner
 * la CallSession. La conversation elle-même (historique, commandes, outils) reste dans ConversationDO.
 */
export class CallDO extends DurableObject<Env> {
  private socket: WebSocket | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tenant = await tenantById(this.env, url.searchParams.get("tenant") ?? "");
    const sessionId = url.searchParams.get("session") ?? "";
    if (!tenant || !sessionId) return new Response("not_found", { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    // Un seul appel à la fois par visiteur : le nouvel appel remplace l'ancien.
    try {
      this.socket?.close(4000, "Nouvel appel");
    } catch {}
    this.socket = server;

    let hint = "";
    try {
      hint = (await loadCatalog(tenant)).products.map((p) => p.name).join(", ");
    } catch {}
    const transcribe = callTranscriber(this.env.AI, hint, (message) => console.log("Appel :", message));
    const speak = speakerFor(this.env);
    const conversation = this.env.CONVERSATIONS.get(this.env.CONVERSATIONS.idFromName(webConversation(tenant.id, sessionId)));

    const send = (message: ServerMessage) => {
      if (message.type === "timing") console.log("Appel : délais (ms)", JSON.stringify(message));
      try {
        server.send(JSON.stringify(message));
        if (message.type === "end") server.close(1000, message.reason);
      } catch {}
    };
    const call = new CallSession({
      transcribe,
      think: (text) => conversation.chat(tenant.id, sessionId, VOICE_PREFIX + text),
      speak: (text) => speak(text),
      send,
      now: Date.now,
      log: (message, err) => console.error(message, err ?? ""),
    });
    const timer = setTimeout(() => call.end("time"), MAX_CALL_MS);

    // Sans ce réglage, les Workers récents livrent le son en Blob, et il était ignoré.
    server.binaryType = "arraybuffer";
    let order = Promise.resolve();
    server.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data === "string") {
        try {
          call.control(JSON.parse(data) as ClientMessage);
        } catch {}
        return;
      }
      // Lu dans l'ordre d'arrivée, même si un Blob demande une lecture asynchrone.
      order = order
        .then(async () => {
          const bytes = await binaryMessage(data);
          if (bytes?.byteLength && bytes.byteLength % 2 === 0) call.audio(new Int16Array(bytes));
        })
        .catch(() => {});
    });
    const hangUp = () => {
      clearTimeout(timer);
      call.close();
      if (this.socket === server) this.socket = null;
      try {
        server.close(1000, "Appel terminé");
      } catch {}
    };
    server.addEventListener("close", hangUp);
    server.addEventListener("error", hangUp);

    call.start();
    return new Response(null, { status: 101, webSocket: client });
  }
}
