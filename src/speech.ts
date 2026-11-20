import { bytesToBase64 } from "./encoding";
import type { Env } from "./types";

/** Synthèse vocale : texte → MP3 en base64, ou null si elle échoue. */
export type Speaker = (text: string) => Promise<string | null>;

/** Voix française gratuite de Workers AI (MyShell MeloTTS). Cloudflare a annoncé son retrait. */
export const TTS_MODEL = "@cf/myshell-ai/melotts";

export function workersAiSpeaker(ai: Ai): Speaker {
  return async (text) => {
    const result = (await (ai as any).run(TTS_MODEL, { prompt: text, lang: "fr" })) as { audio?: string };
    return result?.audio ?? null;
  };
}

/** Voix des exemples de la documentation ElevenLabs ; à remplacer par ELEVENLABS_VOICE_ID. */
export const ELEVENLABS_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
/** Modèle rapide (~100 ms d'après ElevenLabs), qui parle français. */
export const ELEVENLABS_DEFAULT_MODEL = "eleven_flash_v2_5";

type FetchLike = typeof fetch;

/** Voix française d'ElevenLabs, en MP3. */
export function elevenLabsSpeaker(
  apiKey: string,
  options: { voiceId?: string; model?: string } = {},
  fetchFn: FetchLike = (input, init) => fetch(input, init),
): Speaker {
  const voiceId = options.voiceId?.trim() || ELEVENLABS_DEFAULT_VOICE;
  const model = options.model?.trim() || ELEVENLABS_DEFAULT_MODEL;
  return async (text) => {
    const res = await fetchFn(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey.trim(), "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: model,
          // Le modèle multilingual_v2 refuse language_code ; les autres s'en servent pour lire les nombres en français.
          ...(model === "eleven_multilingual_v2" ? {} : { language_code: "fr" }),
          apply_text_normalization: "on",
        }),
      },
    );
    if (!res.ok) throw new Error(`ElevenLabs ${res.status} : ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const audio = new Uint8Array(await res.arrayBuffer());
    return audio.length ? bytesToBase64(audio) : null;
  };
}

/**
 * La voix de Wakil : ElevenLabs si la clé ELEVENLABS_API_KEY est configurée, sinon la voix gratuite
 * de Workers AI. Si ElevenLabs échoue, la voix gratuite prend le relais pour cette phrase.
 */
export function speakerFor(env: Env, fetchFn?: FetchLike, log = (m: string, e: unknown) => console.error(m, e)): Speaker {
  const free = workersAiSpeaker(env.AI);
  if (!env.ELEVENLABS_API_KEY?.trim()) return free;
  const premium = elevenLabsSpeaker(env.ELEVENLABS_API_KEY, { voiceId: env.ELEVENLABS_VOICE_ID, model: env.ELEVENLABS_MODEL }, fetchFn);
  return async (text) => {
    try {
      return await premium(text);
    } catch (err) {
      log("Voix ElevenLabs échouée, voix gratuite utilisée", err);
      return free(text);
    }
  };
}
