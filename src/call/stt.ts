import { workersAiTranscriber } from "../transcribe";

/** Deepgram Nova-3 sur Workers AI : fait pour la parole en direct, bien plus rapide que Whisper. */
export const FAST_STT_MODEL = "@cf/deepgram/nova-3";

export type CallTranscriber = (wav: Uint8Array) => Promise<string>;

/**
 * Transcription d'une phrase de l'appel : Nova-3 d'abord (rapide), Whisper si Nova-3 échoue ou ne rend rien.
 * `log` reçoit le modèle utilisé et la durée, pour comparer dans les journaux.
 */
export function callTranscriber(ai: Ai, hint: string, log: (message: string) => void = () => {}): CallTranscriber {
  const whisper = workersAiTranscriber(ai);
  return async (wav) => {
    const started = Date.now();
    try {
      const result = (await (ai as any).run(FAST_STT_MODEL, {
        audio: { body: new Blob([wav]).stream(), contentType: "audio/wav" },
        language: "fr",
        smart_format: true,
        punctuate: true,
      })) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
      const text = (result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
      log(`Transcription Nova-3 : ${Date.now() - started} ms`);
      if (text) return text;
    } catch (err) {
      log(`Nova-3 échoué (${Date.now() - started} ms) : ${err instanceof Error ? err.message : String(err)}`);
    }
    const fallback = Date.now();
    const text = await whisper(wav, "audio/wav", hint);
    log(`Transcription Whisper : ${Date.now() - fallback} ms`);
    return text;
  };
}
