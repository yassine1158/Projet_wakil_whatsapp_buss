import type { WebReply } from "../conversation-do";
import { pcm16ToWav } from "./audio";
import { speechChunks } from "./chunks";
import { Endpointer, type EndpointerOptions } from "./endpointer";

export const NOT_HEARD = "Je n'ai pas bien entendu. Pouvez-vous répéter ?";
export const TECHNICAL_PROBLEM = "Désolé, j'ai un petit souci technique. Pouvez-vous répéter, ou écrire votre message ?";

export type CallState = "listening" | "thinking" | "speaking";
export type EndReason = "silence" | "turns" | "time" | "hangup";

/** Messages envoyés au navigateur (en JSON). Le son du client arrive à part, en binaire. */
export type ServerMessage =
  | { type: "ready" }
  | { type: "state"; state: CallState }
  | { type: "heard"; text: string }
  | { type: "replies"; replies: WebReply[] }
  | { type: "audio"; format: "mp3"; data: string }
  | { type: "spoken" }
  | { type: "timing"; stt: number; brain: number; firstAudio: number | null }
  | { type: "end"; reason: EndReason };

export type ClientMessage = { type: "interrupt" } | { type: "bye" };

export interface CallDeps {
  /** Son d'une phrase (WAV) → texte. */
  transcribe: (wav: Uint8Array) => Promise<string>;
  /** Texte du client → réponses de Wakil (même conversation que le chat écrit). */
  think: (text: string) => Promise<WebReply[]>;
  /** Texte → MP3 en base64, ou null. */
  speak: (text: string) => Promise<string | null>;
  send: (message: ServerMessage) => void;
  now: () => number;
  log?: (message: string, err?: unknown) => void;
}

export interface CallOptions {
  /** Nombre maximal de phrases du client par appel. */
  maxTurns?: number;
  /** Raccroche après ce silence, quand Wakil n'a plus rien à dire. */
  idleMs?: number;
  endpointer?: Partial<EndpointerOptions>;
}

/**
 * Un appel en direct : écoute le flux du micro, repère chaque phrase du client, la transcrit,
 * demande la réponse au même moteur que le chat, puis la dit phrase par phrase.
 * Indépendant du WebSocket et du Durable Object, pour être testé seul.
 */
export class CallSession {
  private readonly endpointer: Endpointer;
  private readonly maxTurns: number;
  private readonly idleMs: number;
  private queue: Promise<void> = Promise.resolve();
  private turns = 0;
  private pending = 0;
  private generation = 0;
  private ended = false;
  private lastActivity: number;

  constructor(
    private readonly deps: CallDeps,
    options: CallOptions = {},
  ) {
    this.endpointer = new Endpointer(options.endpointer);
    this.maxTurns = options.maxTurns ?? 40;
    this.idleMs = options.idleMs ?? 60_000;
    this.lastActivity = deps.now();
  }

  start(): void {
    this.deps.send({ type: "ready" });
    this.deps.send({ type: "state", state: "listening" });
  }

  /** Son du micro : PCM 16 bits, mono, 16 kHz. */
  audio(chunk: Int16Array): void {
    if (this.ended) return;
    for (const event of this.endpointer.push(chunk)) {
      if (event.type === "end") this.enqueue(event.audio);
    }
    const now = this.deps.now();
    if (this.endpointer.speaking || this.pending) this.lastActivity = now;
    else if (now - this.lastActivity > this.idleMs) this.end("silence");
  }

  control(message: ClientMessage): void {
    if (message.type === "interrupt") this.generation++;
    if (message.type === "bye") this.end("hangup");
  }

  end(reason: EndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.deps.send({ type: "end", reason });
  }

  /** Fin de l'appel sans rien envoyer (le client a déjà raccroché). */
  close(): void {
    this.ended = true;
  }

  /** Attend la fin des réponses en cours (pour les tests). */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
  }

  private enqueue(audio: Int16Array) {
    if (this.turns >= this.maxTurns) return;
    this.turns++;
    this.pending++;
    this.queue = this.queue
      .then(() => this.turn(audio))
      .catch((err) => this.deps.log?.("Échange de l'appel échoué", err))
      .finally(() => {
        this.pending--;
        this.lastActivity = this.deps.now();
        if (!this.pending && this.turns >= this.maxTurns) this.end("turns");
      });
  }

  private async turn(audio: Int16Array) {
    if (this.ended) return;
    const { deps } = this;
    const generation = this.generation;
    const stopped = () => this.ended || generation !== this.generation;
    const started = deps.now();
    deps.send({ type: "state", state: "thinking" });

    let text: string;
    try {
      text = (await deps.transcribe(pcm16ToWav(audio))).trim();
    } catch (err) {
      deps.log?.("Transcription de l'appel échouée", err);
      await this.say([NOT_HEARD], stopped, started);
      if (!this.ended) deps.send({ type: "state", state: "listening" });
      return;
    }
    const stt = deps.now() - started;
    if (!text) {
      if (!this.ended) deps.send({ type: "state", state: "listening" });
      return;
    }
    if (this.ended) return;
    deps.send({ type: "heard", text });

    const thinking = deps.now();
    let replies: WebReply[];
    try {
      replies = await deps.think(text);
    } catch (err) {
      deps.log?.("Réponse de l'appel échouée", err);
      replies = [{ type: "text", text: TECHNICAL_PROBLEM }];
    }
    const brain = deps.now() - thinking;
    if (this.ended) return;
    deps.send({ type: "replies", replies });

    const said = replies.flatMap((r) => (r.type === "text" ? [r.text] : [])).join("\n");
    const firstAudio = await this.say(speechChunks(said), stopped, started);
    if (this.ended) return;
    deps.send({ type: "timing", stt, brain, firstAudio });
    deps.send({ type: "state", state: "listening" });
  }

  /** Dit les morceaux un par un ; s'arrête net si le client coupe la parole. Rend le délai du premier son. */
  private async say(chunks: string[], stopped: () => boolean, started: number): Promise<number | null> {
    if (!chunks.length || stopped()) return null;
    const { deps } = this;
    deps.send({ type: "state", state: "speaking" });
    let firstAudio: number | null = null;
    for (const chunk of chunks) {
      if (stopped()) return firstAudio;
      let data: string | null = null;
      try {
        data = await deps.speak(chunk);
      } catch (err) {
        deps.log?.("Synthèse vocale de l'appel échouée", err);
      }
      if (stopped()) return firstAudio;
      if (!data) continue;
      deps.send({ type: "audio", format: "mp3", data });
      firstAudio ??= deps.now() - started;
    }
    deps.send({ type: "spoken" });
    return firstAudio;
  }
}
