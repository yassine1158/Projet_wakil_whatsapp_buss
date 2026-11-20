import { bytesToBase64 } from "./encoding";

/** Transforme un vocal en texte. `hint` oriente le vocabulaire (noms de produits, quartiers). */
export type Transcriber = (audio: Uint8Array, mimeType: string, hint: string) => Promise<string>;

const TURBO = "@cf/openai/whisper-large-v3-turbo";
const CLASSIC = "@cf/openai/whisper";

/** Whisper ne lit que le début de l'indice (environ 220 jetons) : inutile d'envoyer tout le catalogue. */
export const MAX_HINT_LENGTH = 500;

/**
 * Transcription par Whisper sur Workers AI : pas de clé ni de compte en plus chez Cloudflare.
 * Si Whisper turbo échoue ou ne rend rien, l'ancien Whisper (qui lit les octets bruts) prend le relais.
 */
export function workersAiTranscriber(ai: Ai): Transcriber {
  return async (audio, _mimeType, hint) => {
    const prompt = hint.slice(0, MAX_HINT_LENGTH).trim();
    let turboError: unknown;
    try {
      const result = (await (ai as any).run(TURBO, {
        audio: bytesToBase64(audio),
        ...(prompt ? { initial_prompt: prompt } : {}),
      })) as { text?: string };
      const text = (result.text ?? "").trim();
      if (text) return text;
    } catch (err) {
      turboError = err;
    }
    try {
      const result = (await (ai as any).run(CLASSIC, { audio: Array.from(audio) })) as { text?: string };
      return (result.text ?? "").trim();
    } catch (err) {
      const turbo = turboError ? `turbo : ${errorText(turboError)}` : "turbo : aucun texte";
      throw new Error(`Whisper ${turbo} ; classique : ${errorText(err)}`);
    }
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
