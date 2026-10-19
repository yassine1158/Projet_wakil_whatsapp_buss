import type { ConversationMeta } from "./types";

/** Noms des Durable Objects : une conversation par client, une boîte de réception. */
export const INBOX_NAME = "inbox";

export const whatsappConversation = (phoneNumberId: string, customerPhone: string) => `${phoneNumberId}:${customerPhone}`;

export const webConversation = (tenantId: string, sessionId: string) => `web:${tenantId}:${sessionId}`;

export function conversationKey(meta: ConversationMeta, tenantId: string): string {
  return meta.channel === "web"
    ? webConversation(tenantId, meta.customerId)
    : whatsappConversation(meta.phoneNumberId, meta.customerId);
}
