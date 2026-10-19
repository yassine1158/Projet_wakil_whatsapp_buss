import Anthropic from "@anthropic-ai/sdk";
import { SERVER_FALLBACK_MODELS } from "./agent";
import { DEFAULT_FREE_MODEL, workersAiClient } from "./free-model";
import type { Env } from "./types";

export interface Diagnostic {
  ok: boolean;
  model: string;
  /** Explication à montrer au patron, en clair. */
  message: string;
  /** Détail technique renvoyé par l'API, pour le support. */
  detail?: string;
  /** Quand Claude ne répond pas : état du modèle gratuit qui prend le relais. */
  free?: { ok: boolean; model: string; message: string; detail?: string };
}

/** Traduit une erreur de l'API Claude en une consigne compréhensible. */
export function explainError(status: number | undefined, type: string | undefined, message: string): string {
  const text = message.toLowerCase();
  if (status === 401 || type === "authentication_error") {
    return "Clé refusée par Anthropic. Recopiez la clé en entier dans le secret ANTHROPIC_API_KEY de GitHub (elle commence par sk-ant-), puis relancez « Mettre en ligne ».";
  }
  if (text.includes("credit balance")) {
    return "Crédit Anthropic épuisé ou pas encore ajouté. Ajoutez du crédit sur console.anthropic.com → Billing, puis réessayez (pas besoin de relancer la mise en ligne).";
  }
  if (status === 403 || type === "permission_error") {
    return "Cette clé n'a pas accès au modèle demandé. Vérifiez l'espace de travail de la clé sur console.anthropic.com.";
  }
  if (status === 404 || type === "not_found_error") {
    return "Modèle introuvable. Vérifiez CLAUDE_MODEL dans wrangler.jsonc.";
  }
  if (status === 429 || type === "rate_limit_error") {
    return "Trop de demandes d'un coup chez Anthropic. Réessayez dans une minute ; si cela dure, augmentez les limites du compte.";
  }
  if (status === 529 || type === "overloaded_error" || (status ?? 0) >= 500) {
    return "Anthropic est momentanément surchargé. Réessayez dans quelques minutes.";
  }
  if (status === 400) return "La demande a été refusée par Anthropic. Envoyez le détail ci-dessous au support.";
  return "Connexion à Anthropic impossible. Réessayez ; si cela dure, envoyez le détail ci-dessous au support.";
}

/** Vérifie Claude, puis, s'il ne répond pas, le modèle gratuit qui prend alors le relais. */
export async function checkClaude(env: Env): Promise<Diagnostic> {
  const claude = await checkClaudeOnly(env);
  return claude.ok ? claude : { ...claude, free: await checkFreeModel(env) };
}

export async function checkFreeModel(env: Env): Promise<NonNullable<Diagnostic["free"]>> {
  const model = env.FREE_MODEL || DEFAULT_FREE_MODEL;
  try {
    const client = workersAiClient((m, input) => env.AI.run(m as never, input as never), model);
    const reply = await client.beta.messages.create({ model, max_tokens: 64, messages: [{ role: "user", content: "Réponds seulement : OK" }] });
    if (!reply.content.some((b) => b.type === "text")) throw new Error("réponse vide");
    return { ok: true, model, message: "En attendant, Wakil répond avec le modèle gratuit de Cloudflare : réponses plus simples, et une centaine par jour environ." };
  } catch (err) {
    return { ok: false, model, message: "Le modèle gratuit de Cloudflare ne répond pas non plus : Wakil ne peut pas répondre aux clients pour l'instant.", detail: String(err) };
  }
}

/** Petit appel au modèle, avec les mêmes réglages que les vraies conversations. */
async function checkClaudeOnly(env: Env): Promise<Diagnostic> {
  const model = env.CLAUDE_MODEL ?? "claude-opus-5-5";
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, model, message: "Aucune clé : ajoutez le secret ANTHROPIC_API_KEY dans GitHub, puis relancez « Mettre en ligne »." };
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 0 });
  try {
    await client.beta.messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Réponds seulement : OK" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      ...(SERVER_FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    return { ok: true, model, message: "Wakil arrive à joindre Claude : la clé et le crédit sont bons." };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const body = err.error as { error?: { type?: string; message?: string } } | undefined;
      const type = body?.error?.type;
      const message = body?.error?.message ?? err.message;
      return { ok: false, model, message: explainError(err.status, type, message), detail: `${err.status ?? ""} ${type ?? ""} ${message}`.trim() };
    }
    return { ok: false, model, message: explainError(undefined, undefined, String(err)), detail: String(err) };
  }
}
