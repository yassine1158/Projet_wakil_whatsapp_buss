import { CALL_SAMPLE_RATE, rms } from "./audio";

export interface EndpointerOptions {
  sampleRate: number;
  /** Durée d'une trame analysée. */
  frameMs: number;
  /** La parole commence quand `startFrames` trames sur les `windowFrames` dernières sont sonores. */
  startFrames: number;
  windowFrames: number;
  /** Silence qui termine une phrase. */
  endSilenceMs: number;
  /** Silence gardé à la fin de la phrase rendue. */
  trailMs: number;
  /** Au-delà, la phrase est coupée et rendue telle quelle. */
  maxUtteranceMs: number;
  /** Son gardé avant le début détecté, pour ne pas couper le début des mots. */
  preRollMs: number;
  /** Niveau minimal d'une trame sonore, quel que soit le bruit de fond. */
  minLevel: number;
}

const DEFAULTS: EndpointerOptions = {
  sampleRate: CALL_SAMPLE_RATE,
  frameMs: 20,
  startFrames: 8,
  windowFrames: 10,
  endSilenceMs: 700,
  trailMs: 200,
  maxUtteranceMs: 15_000,
  preRollMs: 300,
  minLevel: 400,
};

export type EndpointEvent = { type: "start" } | { type: "end"; audio: Int16Array };

/**
 * Découpe un flux de son en phrases : repère quand le client commence à parler et quand il a fini.
 * Le seuil suit le bruit de fond, pour marcher dans un marché comme dans un bureau.
 */
export class Endpointer {
  private readonly o: EndpointerOptions;
  private readonly frameLength: number;
  private leftover = new Int16Array(0);
  private recent: { samples: Int16Array; voiced: boolean }[] = [];
  private utterance: Int16Array[] = [];
  private utteranceLength = 0;
  private silentFrames = 0;
  private floor = -1;
  private inSpeech = false;

  constructor(options: Partial<EndpointerOptions> = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.frameLength = Math.round((this.o.sampleRate * this.o.frameMs) / 1000);
  }

  /** Vrai pendant que le client parle. */
  get speaking(): boolean {
    return this.inSpeech;
  }

  push(chunk: Int16Array): EndpointEvent[] {
    const all = new Int16Array(this.leftover.length + chunk.length);
    all.set(this.leftover);
    all.set(chunk, this.leftover.length);
    const events: EndpointEvent[] = [];
    let offset = 0;
    for (; offset + this.frameLength <= all.length; offset += this.frameLength) {
      this.frame(all.slice(offset, offset + this.frameLength), events);
    }
    this.leftover = all.slice(offset);
    return events;
  }

  private frame(samples: Int16Array, events: EndpointEvent[]) {
    const level = rms(samples);
    if (this.floor < 0) this.floor = Math.min(level, this.o.minLevel);
    const voiced = level > Math.max(this.o.minLevel, this.floor * 3);

    if (!this.inSpeech) {
      if (!voiced) this.floor = this.floor * 0.9 + level * 0.1;
      this.recent.push({ samples, voiced });
      const keep = Math.max(this.o.windowFrames, Math.round(this.o.preRollMs / this.o.frameMs));
      if (this.recent.length > keep) this.recent.shift();
      const voicedCount = this.recent.slice(-this.o.windowFrames).filter((f) => f.voiced).length;
      if (voicedCount >= this.o.startFrames) {
        this.inSpeech = true;
        this.utterance = this.recent.map((f) => f.samples);
        this.utteranceLength = this.utterance.reduce((n, f) => n + f.length, 0);
        this.silentFrames = 0;
        this.recent = [];
        events.push({ type: "start" });
      }
      return;
    }

    this.utterance.push(samples);
    this.utteranceLength += samples.length;
    this.silentFrames = voiced ? 0 : this.silentFrames + 1;

    if (this.silentFrames * this.o.frameMs >= this.o.endSilenceMs) {
      const extra = this.silentFrames - Math.round(this.o.trailMs / this.o.frameMs);
      this.finish(events, Math.max(0, extra));
    } else if ((this.utteranceLength / this.o.sampleRate) * 1000 >= this.o.maxUtteranceMs) {
      this.finish(events, 0);
    }
  }

  private finish(events: EndpointEvent[], dropFrames: number) {
    const frames = dropFrames ? this.utterance.slice(0, -dropFrames) : this.utterance;
    const audio = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let offset = 0;
    for (const f of frames) {
      audio.set(f, offset);
      offset += f.length;
    }
    this.inSpeech = false;
    this.utterance = [];
    this.utteranceLength = 0;
    this.silentFrames = 0;
    events.push({ type: "end", audio });
  }
}
