import { handleApi } from "./api";
import { whatsappConversation } from "./names";
import { tenantByPhoneNumberId } from "./registry";
import type { Env, IncomingMessage, Tenant } from "./types";
import { handleLead } from "./leads";
import { handleChat } from "./web";
import { handleVoice } from "./voice";
import { parseWebhook, verifySignature, WhatsAppClient } from "./whatsapp";

export { ConversationDO } from "./conversation-do";
export { InboxDO } from "./inbox-do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "GET") {
      // Vérification de l'URL par Meta lors de la configuration du webhook.
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === env.WHATSAPP_VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const raw = await request.text();
      if (!(await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET))) {
        return new Response("Invalid signature", { status: 401 });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }
      for (const { phoneNumberId, message } of parseWebhook(payload)) {
        const tenant = await tenantByPhoneNumberId(env, phoneNumberId);
        if (!tenant) {
          console.warn(`Numéro relié à aucune entreprise : ${phoneNumberId}`);
          continue;
        }
        if (message.from === tenant.ownerPhone && (await handleOwnerCommand(env, phoneNumberId, tenant, message))) {
          continue;
        }
        await conversation(env, phoneNumberId, message.from).enqueue(tenant.id, phoneNumberId, message);
      }
      // Répondre vite : Meta renvoie la notification si le 200 tarde.
      return new Response("OK");
    }

    if (url.pathname === "/chat" || url.pathname === "/chat/config") {
      return handleChat(request, env, url);
    }

    if (url.pathname === "/voice") {
      return handleVoice(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (url.pathname === "/leads") {
      return handleLead(request, env, url);
    }

    // La page d'accueil (public/index.html) est servie avant d'arriver ici.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Wakil est en ligne.");
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function conversation(env: Env, phoneNumberId: string, customerPhone: string) {
  return env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(whatsappConversation(phoneNumberId, customerPhone)));
}

/**
 * Commandes du patron, envoyées depuis son WhatsApp au numéro de l'assistant :
 *   #pause 2250700000000   → l'assistant ne répond plus à ce client (12 h par défaut)
 *   #reprendre 2250700000000 → l'assistant reprend la conversation
 * Tout autre message du patron est traité comme celui d'un client (pratique pour tester).
 */
async function handleOwnerCommand(
  env: Env,
  phoneNumberId: string,
  tenant: Tenant,
  message: IncomingMessage,
): Promise<boolean> {
  const match = message.kind === "text" ? /^#(pause|reprendre)\s+\+?(\d{8,15})\s*$/i.exec(message.text ?? "") : null;
  if (!match) return false;
  const [, command, customerPhone] = match;
  const target = conversation(env, phoneNumberId, customerPhone);
  const hours = tenant.handoffHours ?? 12;
  if (command.toLowerCase() === "pause") await target.pause(hours);
  else await target.resume();
  const reply =
    command.toLowerCase() === "pause"
      ? `⏸️ L'assistant ne répond plus à +${customerPhone} pendant ${hours} h.`
      : `▶️ L'assistant reprend la conversation avec +${customerPhone}.`;
  await new WhatsAppClient(env.WHATSAPP_TOKEN, phoneNumberId, env.GRAPH_API_VERSION)
    .sendText(message.from, reply)
    .catch((e) => console.error("Réponse au patron échouée", e));
  return true;
}
