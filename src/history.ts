import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;

/** Nombre maximal de messages gardés d'un tour à l'autre. */
export const MAX_HISTORY_MESSAGES = 40;

/**
 * Prépare l'historique pour le stockage entre deux tours :
 * - retire les blocs de réflexion (ils ne sont jamais renvoyés d'un tour à l'autre,
 *   ce qui laisse libre de raccourcir l'historique ou de mettre à jour le catalogue) ;
 * - remplace les photos par une mention texte (stockage léger, coût réduit) ;
 * - ne garde que les champs utiles des blocs.
 */
export function sanitizeHistory(messages: MessageParam[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content } as BlockParam] : m.content;
    const kept: BlockParam[] = [];
    for (const b of blocks) {
      switch (b.type) {
        case "text":
          if (b.text) kept.push({ type: "text", text: b.text });
          break;
        case "image":
          kept.push({ type: "text", text: "[Photo envoyée par le client]" });
          break;
        case "tool_use":
          if (m.role === "assistant") kept.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
          break;
        case "tool_result":
          if (m.role === "user") {
            kept.push({
              type: "tool_result",
              tool_use_id: b.tool_use_id,
              content: b.content,
              ...(b.is_error ? { is_error: true } : {}),
            });
          }
          break;
        default:
          // thinking, redacted_thinking, fallback… : non conservés entre les tours.
          break;
      }
    }
    if (kept.length) out.push({ role: m.role, content: kept });
  }
  return out;
}

function isToolResultOnly(m: MessageParam): boolean {
  return (
    m.role === "user" &&
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((b) => b.type === "tool_result")
  );
}

/**
 * Garde les derniers messages en coupant sur un message du client (jamais au milieu
 * d'un échange outil, et toujours en commençant par un message "user").
 */
export function trimHistory(messages: MessageParam[], max = MAX_HISTORY_MESSAGES): MessageParam[] {
  if (messages.length <= max) return dropLeadingNonUser(messages);
  for (let i = messages.length - max; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && !isToolResultOnly(m)) return messages.slice(i);
  }
  return [];
}

function dropLeadingNonUser(messages: MessageParam[]): MessageParam[] {
  const i = messages.findIndex((m) => m.role === "user" && !isToolResultOnly(m));
  return i <= 0 ? (i === 0 ? messages : []) : messages.slice(i);
}
