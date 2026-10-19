import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeClient } from "./agent";

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type BetaMessage = Anthropic.Beta.BetaMessage;

/**
 * Modèle gratuit de Cloudflare (Workers AI), utilisé quand Claude n'est pas joignable
 * (pas de clé, crédit épuisé, panne). Les 10 000 « neurones » offerts chaque jour
 * suffisent pour une centaine de réponses environ.
 */
export const DEFAULT_FREE_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** Consigne ajoutée pour le modèle gratuit, moins rodé aux outils que Claude. */
const FREE_MODEL_NOTE =
  "\n\nPour envoyer une photo, enregistrer une commande ou passer la main à l'équipe, appelle l'outil correspondant ; n'écris jamais un appel d'outil dans ton message.";

const PHOTO_NOTE = "[Le client a envoyé une photo que tu ne peux pas voir : demande-lui de décrire ce qu'il cherche.]";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Fonction d'appel au modèle : `env.AI.run`, remplaçable dans les tests. */
export type AiRun = (model: string, input: Record<string, unknown>) => Promise<unknown>;

const blockText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? PHOTO_NOTE : "")).filter(Boolean).join("\n")
      : "";

/** Traduit une demande au format Claude en messages au format « chat completions ». */
export function toChatMessages(params: Pick<CreateParams, "system" | "messages">): ChatMessage[] {
  const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("\n\n");
  const out: ChatMessage[] = [{ role: "system", content: system + FREE_MODEL_NOTE }];

  for (const m of params.messages as MessageParam[]) {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n\n");
      const calls: ToolCall[] = blocks
        .filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (text || calls.length) out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Côté client : d'abord les résultats d'outils (ils répondent au message précédent), puis le texte.
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: blockText(b.content) || "(vide)" });
      else if (b.type === "text") texts.push(b.text);
      else if (b.type === "image") texts.push(PHOTO_NOTE);
      else if (b.type === "document") texts.push("[Document envoyé par le client]");
    }
    if (texts.length) out.push({ role: "user", content: texts.join("\n") });
  }
  return out;
}

const safeId = (id: unknown, i: number) => {
  const clean = typeof id === "string" ? id.replace(/[^a-zA-Z0-9_-]/g, "_") : "";
  return clean || `toolu_gratuit_${Date.now().toString(36)}_${i}`;
};

function parseArguments(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(args ?? "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Traduit la réponse du modèle gratuit en message au format Claude. */
export function fromChatCompletion(output: unknown, model: string): BetaMessage {
  const o = output as Record<string, any>;
  // Format « chat completions » (choices) ou ancien format de Workers AI (response, tool_calls).
  const message = o?.choices?.[0]?.message ?? { content: o?.response, tool_calls: o?.tool_calls };
  const finish: string | undefined = o?.choices?.[0]?.finish_reason;
  const text = String(message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const calls: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

  const content: Anthropic.Beta.BetaContentBlock[] = [];
  if (text) content.push({ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock);
  calls.forEach((c, i) => {
    const name = c?.function?.name ?? c?.name;
    if (!name) return;
    content.push({ type: "tool_use", id: safeId(c?.id, i), name, input: parseArguments(c?.function?.arguments ?? c?.arguments) } as Anthropic.Beta.BetaToolUseBlock);
  });

  const hasTools = content.some((b) => b.type === "tool_use");
  return {
    id: `msg_gratuit_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: hasTools ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: o?.usage?.prompt_tokens ?? 0, output_tokens: o?.usage?.completion_tokens ?? 0 },
  } as unknown as BetaMessage;
}

/** Client « façon Claude » qui fait répondre le modèle gratuit de Workers AI. */
export function workersAiClient(run: AiRun, model = DEFAULT_FREE_MODEL): ClaudeClient {
  return {
    beta: {
      messages: {
        async create(params) {
          const tools = (params.tools ?? [])
            .filter((t): t is Anthropic.Beta.BetaTool => "input_schema" in t)
            .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
          const output = await run(model, {
            messages: toChatMessages(params),
            ...(tools.length ? { tools } : {}),
            max_tokens: 2048,
            temperature: 0.4,
            chat_template_kwargs: { enable_thinking: false },
          });
          return fromChatCompletion(output, model);
        },
      },
    },
  };
}

/** Quand Claude refuse pour une raison de compte (clé, crédit), on ne le réessaie qu'au bout de ce délai. */
export const CLAUDE_RETRY_MS = 10 * 60_000;

export interface FallbackState {
  claudeDownUntil: number;
}
const sharedState: FallbackState = { claudeDownUntil: 0 };

function isAccountProblem(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 401 || e?.status === 403 || /credit balance|billing/i.test(String(e?.message ?? ""));
}

/**
 * Essaie Claude, et passe au modèle gratuit s'il ne répond pas. Dès que du crédit est
 * ajouté, Claude reprend la main tout seul (au plus tard après CLAUDE_RETRY_MS).
 */
export function withFreeFallback(
  claude: ClaudeClient | null,
  free: ClaudeClient,
  options: { now?: () => number; state?: FallbackState; log?: (message: string) => void } = {},
): ClaudeClient {
  const { now = Date.now, state = sharedState, log = (m) => console.warn(m) } = options;
  return {
    beta: {
      messages: {
        async create(params) {
          if (claude && now() >= state.claudeDownUntil) {
            try {
              return await claude.beta.messages.create(params);
            } catch (err) {
              if (isAccountProblem(err)) state.claudeDownUntil = now() + CLAUDE_RETRY_MS;
              log(`Claude indisponible, réponse par le modèle gratuit : ${(err as Error).message}`);
            }
          }
          return free.beta.messages.create(params);
        },
      },
    },
  };
}
