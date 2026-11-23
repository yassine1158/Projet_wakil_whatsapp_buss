/** Son des appels : PCM 16 bits signé, mono, 16 kHz (le navigateur rééchantillonne le micro). */
export const CALL_SAMPLE_RATE = 16000;

/** Niveau sonore moyen (racine de la moyenne des carrés), de 0 à 32768. */
export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Emballe du PCM 16 bits mono dans un fichier WAV, le format le plus simple à transcrire. */
export function pcm16ToWav(samples: Int16Array, sampleRate = CALL_SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) out[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // taille du bloc fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // octets par seconde
  view.setUint16(32, 2, true); // octets par échantillon
  view.setUint16(34, 16, true); // bits par échantillon
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

/**
 * Octets d'un message WebSocket binaire. Selon la date de compatibilité des Workers, il arrive
 * en ArrayBuffer ou en Blob (norme) : les deux sont acceptés. Rend null pour un message texte.
 */
export async function binaryMessage(data: unknown): Promise<ArrayBuffer | null> {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.arrayBuffer();
  return null;
}
