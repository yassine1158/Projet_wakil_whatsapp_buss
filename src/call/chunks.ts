import { speakable } from "../voice";

/**
 * Découpe une réponse en morceaux à dire l'un après l'autre. La première phrase part seule,
 * pour que le client entende Wakil le plus vite possible ; les suivantes sont regroupées.
 */
export function speechChunks(text: string, max = 220): string[] {
  const spoken = speakable(text);
  if (!spoken) return [];
  const sentences = spoken.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    const last = chunks.length > 1 ? chunks[chunks.length - 1] : undefined;
    if (last !== undefined && last.length + 1 + sentence.length <= max) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else chunks.push(sentence.slice(0, max));
  }
  return chunks;
}
