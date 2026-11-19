import Anthropic from "@anthropic-ai/sdk";
import { SERVER_FALLBACK_MODELS } from "./agent";
import { DEFAULT_FREE_MODEL, workersAiClient } from "./free-model";
import type { Env, Tenant } from "./types";

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

export interface WhatsAppDiagnostic {
  ok: boolean;
  message: string;
  detail?: string;
}

/** Traduit une erreur de l'API WhatsApp (Graph) en une consigne compréhensible. */
export function explainWhatsAppError(code: number | undefined, message: string): string {
  if (code === 190) {
    return "Jeton refusé ou expiré par Meta. Créez un nouveau jeton (de préférence permanent, avec l'utilisateur système), mettez-le dans le secret WHATSAPP_TOKEN de GitHub, puis relancez « Mettre en ligne ».";
  }
  if (code === 10 || code === 200 || /permission/i.test(message)) {
    return "Ce jeton n'a pas accès à ce numéro : donnez à l'utilisateur système le compte WhatsApp (contrôle total) et les autorisations whatsapp_business_messaging et whatsapp_business_management.";
  }
  if (code === 100) return "Meta ne trouve pas ce numéro avec ce jeton : vérifiez le Phone number ID dans la fiche de l'entreprise.";
  return "Meta a refusé la demande. Envoyez le détail ci-dessous au support.";
}

/**
 * Vérifie que Wakil peut écrire depuis le numéro de l'entreprise : même jeton que pour les
 * vraies réponses (celui de l'entreprise s'il en a un, sinon WHATSAPP_TOKEN).
 */
export async function checkWhatsApp(
  env: Env,
  tenant: Tenant,
  ownToken: string | null,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<WhatsAppDiagnostic> {
  const phoneNumberId = tenant.whatsapp?.phoneNumberId;
  if (!phoneNumberId) return { ok: false, message: "Aucun numéro relié à cette entreprise : reliez-le dans sa fiche." };
  const raw = ownToken ?? env.WHATSAPP_TOKEN ?? "";
  const token = raw.trim();
  const source = ownToken ? "jeton propre à l'entreprise" : "secret WHATSAPP_TOKEN";
  if (!token) return { ok: false, message: "Aucun jeton : ajoutez le secret WHATSAPP_TOKEN dans GitHub, puis relancez « Mettre en ligne »." };
  try {
    const res = await fetchFn(
      `https://graph.facebook.com/${env.GRAPH_API_VERSION ?? "v23.0"}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const data = (await res.json().catch(() => ({}))) as {
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
      error?: { code?: number; message?: string };
    };
    if (!res.ok) {
      const { code, message = "" } = data.error ?? {};
      return { ok: false, message: explainWhatsAppError(code, message), detail: `${res.status} ${code ?? ""} ${message} (${source})`.replace(/\s+/g, " ").trim() };
    }
    const testNumber = data.verified_name === "Test Number";
    return {
      ok: true,
      message: [
        `Wakil peut écrire depuis ${data.display_phone_number ?? "ce numéro"}${data.quality_rating ? ` (qualité ${data.quality_rating})` : ""}.`,
        testNumber ? "Numéro de test : Meta n'écrit qu'aux numéros ajoutés dans « Destinataire », sur la page Configuration de l'API." : "",
        raw !== token ? "Le jeton contenait des espaces en trop : ils sont ignorés." : "",
      ].filter(Boolean).join(" "),
    };
  } catch (err) {
    return { ok: false, message: "Connexion à Meta impossible. Réessayez.", detail: String(err) };
  }
}
