import { DurableObject } from "cloudflare:workers";
import { loadCatalog } from "../catalog";
import { webConversation } from "../names";
import { tenantById } from "../registry";
import { speakerFor } from "../speech";
import { workersAiTranscriber } from "../transcribe";
import type { Env } from "../types";
import { VOICE_PREFIX } from "../voice";
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
    const transcribe = workersAiTranscriber(this.env.AI);
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
      transcribe: (wav) => transcribe(wav, "audio/wav", hint),
      think: (text) => conversation.chat(tenant.id, sessionId, VOICE_PREFIX + text),
      speak: (text) => speak(text),
      send,
      now: Date.now,
      log: (message, err) => console.error(message, err ?? ""),
    });
    const timer = setTimeout(() => call.end("time"), MAX_CALL_MS);

    server.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          call.control(JSON.parse(event.data) as ClientMessage);
        } catch {}
        return;
      }
      const data = event.data as ArrayBuffer;
      if (data.byteLength && data.byteLength % 2 === 0) call.audio(new Int16Array(data));
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
