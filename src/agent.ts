import type Anthropic from "@anthropic-ai/sdk";
import { runTool, TOOLS, type ToolContext } from "./tools";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Ce dont l'agent a besoin du SDK : permet de le remplacer dans les tests. */
export interface ClaudeClient {
  beta: { messages: { create(params: CreateParams): PromiseLike<Anthropic.Beta.BetaMessage> } };
}

export interface AgentConfig {
  model: string;
  effort: Effort;
  maxIterations?: number;
}

export interface AgentResult {
  /** Messages à ajouter à l'historique (le message du client compris). */
  newMessages: MessageParam[];
  /** Textes à envoyer au client, dans l'ordre. */
  replies: string[];
  refused: boolean;
}

/** Modèles qui acceptent le repli automatique côté serveur en cas de refus. */
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export const REFUSAL_REPLY =
  "Je ne peux pas répondre à cette demande. Un conseiller de l'équipe peut vous aider si besoin.";

/**
 * Fait répondre le commercial à un tour du client. Boucle manuelle : chaque appel
 * d'outil est exécuté puis renvoyé au modèle, jusqu'à la réponse finale.
 */
export async function runAgent(
  client: ClaudeClient,
  config: AgentConfig,
  systemPrompt: string,
  history: MessageParam[],
  userContent: Anthropic.Beta.BetaContentBlockParam[],
  toolContext: ToolContext,
): Promise<AgentResult> {
  const messages: MessageParam[] = [...history, { role: "user", content: userContent }];
  const start = history.length;
  const replies: string[] = [];
  const maxIterations = config.maxIterations ?? 6;

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: config.effort },
      cache_control: { type: "ephemeral" },
      ...(SERVER_FALLBACK_MODELS.has(config.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    });

    if (response.stop_reason === "refusal") {
      return { newMessages: messages.slice(start), replies: [REFUSAL_REPLY], refused: true };
    }
    if (response.stop_reason === "max_tokens") {
      // Réponse tronquée : on ne l'exécute pas et on ne la garde pas.
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) replies.push(block.text.trim());
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      let outcome;
      try {
        outcome = await runTool(use.name, use.input, toolContext);
      } catch (err) {
        outcome = { content: `Échec de l'outil : ${(err as Error).message}`, isError: true };
      }
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  return { newMessages: messages.slice(start), replies, refused: false };
}
