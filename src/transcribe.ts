import { bytesToBase64 } from "./encoding";

/** Transforme un vocal en texte. `hint` oriente le vocabulaire (noms de produits, quartiers). */
export type Transcriber = (audio: Uint8Array, mimeType: string, hint: string) => Promise<string>;

/** Transcription par Whisper sur Workers AI : pas de clé ni de compte en plus chez Cloudflare. */
export function workersAiTranscriber(ai: Ai): Transcriber {
  return async (audio, _mimeType, hint) => {
    const result = (await (ai as any).run("@cf/openai/whisper-large-v3-turbo", {
      audio: bytesToBase64(audio),
      initial_prompt: hint,
    })) as { text?: string };
    return (result.text ?? "").trim();
  };
}
