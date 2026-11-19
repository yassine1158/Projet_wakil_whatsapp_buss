import modelFile from "./brain-model.json";

/**
 * Wakil Brain : petit modèle d'intention construit et entraîné de zéro (projet WAKIL-AI,
 * `train_intent.py`). À partir du dernier message de l'assistant et du nouveau message du
 * client, il prédit ce que l'assistant doit faire :
 *   reponse (répondre), humain (passer à un conseiller), commande (enregistrer), photo (envoyer une photo).
 *
 * Il tourne en « mode ombre » : sa prédiction est comparée à ce que Claude a vraiment fait et
 * enregistrée, mais elle ne change jamais la réponse envoyée au client.
 *
 * Le découpage du texte reproduit exactement `wakil_ai/intent.py` : mêmes mots, mêmes morceaux
 * de 3 lettres, même hachage FNV-1a. Les cas de test exportés avec le modèle le vérifient.
 */

export const BRAIN_LABELS = ["reponse", "humain", "commande", "photo"] as const;
export type BrainLabel = (typeof BRAIN_LABELS)[number];

export interface BrainFile {
  format: string;
  labels: string[];
  dim: number;
  layer_sizes: number[];
  params: Record<string, { shape: number[]; data: string }>;
  metadata: Record<string, unknown>;
  fixtures: { context: string; text: string; probs: number[] }[];
}

interface Layer {
  W: Float32Array;
  b: Float32Array;
  rows: number;
  cols: number;
}

export interface Brain {
  labels: string[];
  dim: number;
  layers: Layer[];
  metadata: Record<string, unknown>;
}

export interface BrainPrediction {
  label: string;
  confidence: number;
  probs: number[];
}

const encoder = new TextEncoder();

/** Hachage FNV-1a 32 bits des octets UTF-8. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Minuscules, sans accents, chiffres → 0, seulement lettres et chiffres. */
export function words(text: string | null | undefined): string[] {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[0-9]/g, "0")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

export function featureNames(context: string, text: string): string[] {
  const names: string[] = [];
  for (const [prefix, segment] of [["a", context], ["u", text]] as const) {
    for (const word of words(segment)) {
      names.push(`${prefix}w:${word}`);
      const padded = Array.from(`<${word}>`);
      for (let i = 0; i + 3 <= padded.length; i++) names.push(`${prefix}c:${padded.slice(i, i + 3).join("")}`);
    }
  }
  return names;
}

/** Vecteur creux normalisé (norme 1) : position → valeur. */
export function featurize(context: string, text: string, dim: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const name of featureNames(context, text)) {
    const slot = fnv1a(name) % dim;
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  let norm = 0;
  for (const v of counts.values()) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (const [k, v] of counts) counts.set(k, v / norm);
  return counts;
}

function decodeFloat32(base64: string): Float32Array {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function loadBrain(file: BrainFile): Brain {
  if (file.format !== "wakil-brain-1") throw new Error(`Format de modèle inconnu : ${file.format}`);
  const layers: Layer[] = [];
  for (let i = 1; i < file.layer_sizes.length; i++) {
    const W = file.params[`W${i}`];
    const b = file.params[`b${i}`];
    layers.push({ W: decodeFloat32(W.data), b: decodeFloat32(b.data), rows: W.shape[0], cols: W.shape[1] });
  }
  return { labels: file.labels, dim: file.dim, layers, metadata: file.metadata };
}

/** Propagation avant : couches cachées ReLU, softmax à la sortie. */
export function predict(brain: Brain, context: string, text: string): BrainPrediction {
  const [first, ...rest] = brain.layers;
  let h = Float32Array.from(first.b);
  for (const [i, x] of featurize(context, text, brain.dim)) {
    for (let j = 0; j < first.cols; j++) h[j] += x * first.W[i * first.cols + j];
  }
  for (const layer of rest) {
    const next = Float32Array.from(layer.b);
    for (let i = 0; i < layer.rows; i++) {
      const a = Math.max(0, h[i]);
      if (a === 0) continue;
      for (let j = 0; j < layer.cols; j++) next[j] += a * layer.W[i * layer.cols + j];
    }
    h = next;
  }
  const max = Math.max(...h);
  const exp = Array.from(h, (v) => Math.exp(v - max));
  const sum = exp.reduce((s, v) => s + v, 0);
  const probs = exp.map((v) => v / sum);
  const best = probs.indexOf(Math.max(...probs));
  return { label: brain.labels[best], confidence: probs[best], probs };
}

let shared: Brain | null = null;

/** Le modèle livré avec Wakil (`src/brain-model.json`), chargé une seule fois. */
export function defaultBrain(): Brain {
  shared ??= loadBrain(modelFile as BrainFile);
  return shared;
}

/** Ce que Claude a fait pendant ce tour, dans le même vocabulaire que Wakil Brain. */
export function claudeAction(toolNames: string[]): BrainLabel {
  if (toolNames.includes("request_human")) return "humain";
  if (toolNames.includes("record_order")) return "commande";
  if (toolNames.includes("send_product_photo")) return "photo";
  return "reponse";
}

/** Retire numéros de téléphone et adresses e-mail avant d'enregistrer un exemple. */
export function anonymize(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\+?\d[\d\s.-]{5,}\d/g, "[numéro]");
}
