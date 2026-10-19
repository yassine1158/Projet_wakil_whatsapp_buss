import { webConversation } from "./names";
import { findTenantById, isKnownWebOrigin } from "./tenants";
import type { Env, Tenant } from "./types";

const MAX_TEXT = 1000;
const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Le site doit être déclaré par l'entreprise ; la démo est servie par le Worker lui-même. */
function allowed(tenant: Tenant, origin: string | null, url: URL): origin is string {
  return !!origin && (!!tenant.webOrigins?.includes(origin) || (!!tenant.demo && origin === url.origin));
}

function cors(origin: string | null): Record<string, string> {
  return origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "origin",
      }
    : {};
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

/**
 * Chat du site web :
 *   GET  /chat/config?tenant=sicar → nom de l'entreprise et de l'assistant
 *   POST /chat {tenant, session, text} → réponses de l'assistant
 * Seuls les sites listés dans webOrigins de l'entreprise peuvent l'utiliser.
 */
export async function handleChat(request: Request, env: Env, url: URL): Promise<Response> {
  const origin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: origin && isKnownWebOrigin(origin) ? cors(origin) : {} });
  }

  if (url.pathname === "/chat/config" && request.method === "GET") {
    const found = findTenantById(url.searchParams.get("tenant") ?? "");
    // Sans en-tête Origin (requête GET depuis le même site), la réponse n'a rien de sensible.
    if (!found || (origin !== null && !allowed(found.tenant, origin, url))) return json({ error: "forbidden" }, 403, null);
    const { businessName, assistantName } = found.tenant;
    return json({ businessName, assistantName }, 200, origin);
  }

  if (url.pathname !== "/chat" || request.method !== "POST") return json({ error: "not_found" }, 404, null);

  let body: { tenant?: unknown; session?: unknown; text?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400, null);
  }
  const found = typeof body.tenant === "string" ? findTenantById(body.tenant) : undefined;
  if (!found || !allowed(found.tenant, origin, url)) return json({ error: "forbidden" }, 403, null);

  const session = typeof body.session === "string" ? body.session : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!SESSION_RE.test(session) || !text || text.length > MAX_TEXT) return json({ error: "bad_request" }, 400, origin);

  if (env.CHAT_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "inconnu";
    const { success } = await env.CHAT_LIMITER.limit({ key: ip });
    if (!success) return json({ error: "rate_limited" }, 429, origin);
  }

  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(webConversation(found.tenant.id, session)));
  try {
    const replies = await stub.chat(found.phoneNumberId, session, text);
    return json({ replies }, 200, origin);
  } catch (err) {
    console.error("Chat web échoué", err);
    return json({ error: "server_error" }, 500, origin);
  }
}
