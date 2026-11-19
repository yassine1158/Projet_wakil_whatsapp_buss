import { tenantById } from "../registry";
import type { Env } from "../types";
import { allowed } from "../web";

const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Nom du Durable Object d'un appel : une salle par visiteur du site. */
export const callRoom = (tenantId: string, sessionId: string) => `call:${tenantId}:${sessionId}`;

/**
 * Appel en direct depuis le chat du site :
 *   GET /call?tenant=sicar&session=…   (WebSocket)
 * Le navigateur envoie le micro en PCM 16 bits 16 kHz ; Wakil renvoie ses réponses (texte et MP3).
 */
export async function handleCall(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket attendu", { status: 426, headers: { upgrade: "websocket" } });
  }
  const tenant = await tenantById(env, url.searchParams.get("tenant") ?? "");
  if (!tenant || !allowed(tenant, request.headers.get("origin"), url)) return new Response("forbidden", { status: 403 });
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_RE.test(session)) return new Response("bad_request", { status: 400 });
  if (env.CHAT_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "inconnu";
    const { success } = await env.CHAT_LIMITER.limit({ key: ip });
    if (!success) return new Response("rate_limited", { status: 429 });
  }
  const room = env.CALLS.get(env.CALLS.idFromName(callRoom(tenant.id, session)));
  return room.fetch(request);
}
