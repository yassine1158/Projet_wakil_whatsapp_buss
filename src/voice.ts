import { loadCatalog } from "./catalog";
import { webConversation } from "./names";
import { isKnownWebOrigin, tenantById } from "./registry";
import { workersAiTranscriber, type Transcriber } from "./transcribe";
import type { Env, Tenant } from "./types";
import { allowed, cors } from "./web";

/** Un enregistrement de 30 secondes pèse quelques centaines de Ko ; au-delà, on refuse. */
export const MAX_AUDIO_BYTES = 2_000_000;
/** Voix française de Workers AI (MyShell MeloTTS), qui renvoie un MP3 en base64. */
export const TTS_MODEL = "@cf/myshell-ai/melotts";
/** Marque le message pour le modèle : voir la règle du canal web dans prompt.ts. */
export const VOICE_PREFIX = "[Appel vocal] ";
export const NOT_HEARD_REPLY = "Je n'ai pas bien entendu. Pouvez-vous répéter, ou écrire votre message ?";
/** Au-delà, la lecture serait trop longue pour un appel : le texte complet reste affiché. */
const MAX_SPOKEN = 600;
const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Transforme une réponse écrite en texte facile à dire : sans émoji, liens ni mise en forme. */
export function speakable(text: string): string {
  let out = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/[*_~`]/g, "")
    .replace(/^\s*[•·\-–]\s*/gm, "")
    .replace(/(\d+)\s*\/\s*(\d+)/g, "$1 $2")
    .replace(/m³|\bm3\b/g, " mètres cubes")
    .replace(/m²|\bm2\b/g, " mètres carrés")
    .replace(/\bkg\b/g, "kilos")
    .replace(/\bkm\b/g, "kilomètres")
    .replace(/\bF\s?CFA\b|\bXOF\b/g, "francs CFA");
  // 25 000 ou 25.000 → 25000, pour que les milliers se lisent comme un seul nombre
  while (/(\d)[\s  .](\d{3})(?!\d)/.test(out)) out = out.replace(/(\d)[\s  .](\d{3})(?!\d)/g, "$1$2");
  out = out
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;,]$/.test(line) ? line : line + "."))
    .join(" ")
    .replace(/\s+([.,])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (out.length > MAX_SPOKEN) {
    const cut = out.slice(0, MAX_SPOKEN);
    out = cut.slice(0, Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? ")) + 1) || cut;
  }
  return out;
}

/** Synthèse vocale : texte → MP3 en base64, ou null si elle échoue. */
export type Speaker = (text: string) => Promise<string | null>;

export function workersAiSpeaker(ai: Ai): Speaker {
  return async (text) => {
    const result = (await (ai as any).run(TTS_MODEL, { prompt: text, lang: "fr" })) as { audio?: string };
    return result?.audio ?? null;
  };
}

export interface VoiceDeps {
  transcribe: Transcriber;
  speak: Speaker;
  /** Noms des produits, pour aider la transcription. */
  hint: (tenant: Tenant) => Promise<string>;
}

function defaultDeps(env: Env): VoiceDeps {
  return {
    transcribe: workersAiTranscriber(env.AI),
    speak: workersAiSpeaker(env.AI),
    hint: async (tenant) => {
      try {
        return (await loadCatalog(tenant)).products.map((p) => p.name).join(", ");
      } catch {
        return "";
      }
    },
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

/**
 * Appel vocal depuis le chat du site web :
 *   POST /voice?tenant=sicar&session=…   corps : l'enregistrement du micro (webm, mp4, ogg…)
 * → { transcript, replies, audio }   audio : la réponse dite par Wakil (MP3 en base64), ou null.
 * Même conversation, mêmes règles et mêmes outils que le chat écrit : seule l'entrée et la sortie changent.
 */
export async function handleVoice(request: Request, env: Env, url: URL, deps: VoiceDeps = defaultDeps(env)): Promise<Response> {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: origin && (await isKnownWebOrigin(env, origin)) ? cors(origin) : {} });
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404, null);

  const tenant = await tenantById(env, url.searchParams.get("tenant") ?? "");
  if (!tenant || !allowed(tenant, origin, url)) return json({ error: "forbidden" }, 403, null);
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_RE.test(session)) return json({ error: "bad_request" }, 400, origin);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES) return json({ error: "too_large" }, 413, origin);

  if (env.CHAT_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "inconnu";
    const { success } = await env.CHAT_LIMITER.limit({ key: ip });
    if (!success) return json({ error: "rate_limited" }, 429, origin);
  }

  const audio = new Uint8Array(await request.arrayBuffer());
  if (!audio.length) return json({ error: "bad_request" }, 400, origin);
  if (audio.length > MAX_AUDIO_BYTES) return json({ error: "too_large" }, 413, origin);

  let transcript: string;
  try {
    transcript = (await deps.transcribe(audio, request.headers.get("content-type") ?? "", await deps.hint(tenant))).trim();
  } catch (err) {
    console.error("Transcription de l'appel échouée", err);
    return json({ error: "not_understood" }, 422, origin);
  }

  const speak = async (text: string) => {
    try {
      return await deps.speak(speakable(text));
    } catch (err) {
      console.error("Synthèse vocale échouée", err);
      return null;
    }
  };

  if (!transcript) {
    return json({ transcript: "", replies: [{ type: "text", text: NOT_HEARD_REPLY }], audio: await speak(NOT_HEARD_REPLY) }, 200, origin);
  }

  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(webConversation(tenant.id, session)));
  try {
    const replies = await stub.chat(tenant.id, session, VOICE_PREFIX + transcript);
    const said = replies.filter((r) => r.type === "text").map((r) => (r as { text: string }).text).join("\n");
    return json({ transcript, replies, audio: said ? await speak(said) : null }, 200, origin);
  } catch (err) {
    console.error("Appel vocal échoué", err);
    return json({ error: "server_error" }, 500, origin);
  }
}

