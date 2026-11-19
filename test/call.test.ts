import { describe, expect, it } from "vitest";
import { binaryMessage, CALL_SAMPLE_RATE, pcm16ToWav, rms } from "../src/call/audio";
import { Endpointer } from "../src/call/endpointer";
import { speechChunks } from "../src/call/chunks";
import { CallSession, type CallDeps, type ServerMessage } from "../src/call/session";

const FRAME = CALL_SAMPLE_RATE / 50; // 20 ms

/** `ms` millisecondes de son : une voix simulée (sinus fort) ou un bruit de fond faible. */
function tone(ms: number, amplitude = 6000): Int16Array {
  const n = (CALL_SAMPLE_RATE * ms) / 1000;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / CALL_SAMPLE_RATE));
  return out;
}
const quiet = (ms: number) => tone(ms, 40);

/** Envoie le son par paquets de 100 ms, comme le navigateur. */
function feed(target: { audio?: (c: Int16Array) => void; push?: (c: Int16Array) => unknown }, samples: Int16Array) {
  const step = CALL_SAMPLE_RATE / 10;
  const events: unknown[] = [];
  for (let i = 0; i < samples.length; i += step) {
    const chunk = samples.subarray(i, i + step);
    if (target.push) events.push(...(target.push(chunk) as unknown[]));
    else target.audio!(chunk);
  }
  return events;
}

const concat = (...parts: Int16Array[]) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe("audio", () => {
  it("emballe du PCM 16 bits en WAV lisible", () => {
    const wav = pcm16ToWav(new Int16Array([0, 1000, -1000]));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(46, true)).toBe(1000);
    expect(wav.length).toBe(44 + 6);
  });

  it("lit le son d'un message WebSocket, en ArrayBuffer comme en Blob", async () => {
    const bytes = new Uint8Array([1, 0, 2, 0]);
    expect(new Uint8Array((await binaryMessage(bytes.buffer))!)).toEqual(bytes);
    expect(new Uint8Array((await binaryMessage(new Blob([bytes])))!)).toEqual(bytes);
    expect(new Uint8Array((await binaryMessage(new Uint8Array([9, 1, 0, 2, 0]).subarray(1)))!)).toEqual(bytes);
    expect(await binaryMessage('{"type":"bye"}')).toBeNull();
  });

  it("mesure le niveau sonore", () => {
    expect(rms(new Int16Array(FRAME))).toBe(0);
    expect(rms(tone(20))).toBeGreaterThan(3000);
  });
});

describe("Endpointer", () => {
  it("repère une phrase et la rend après un silence", () => {
    const ep = new Endpointer();
    const events = feed(ep, concat(quiet(500), tone(1200), quiet(1000))) as { type: string; audio?: Int16Array }[];
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    const audio = events[1].audio!;
    // La phrase entière, avec un peu de marge avant (le début des mots n'est pas coupé).
    expect(audio.length / CALL_SAMPLE_RATE).toBeGreaterThan(1.2);
    expect(audio.length / CALL_SAMPLE_RATE).toBeLessThan(2.4);
  });

  it("ignore le bruit de fond et les clics trop courts", () => {
    const ep = new Endpointer();
    expect(feed(ep, concat(quiet(2000), tone(60), quiet(1500)))).toEqual([]);
  });

  it("garde une courte pause à l'intérieur d'une phrase", () => {
    const ep = new Endpointer();
    const events = feed(ep, concat(tone(800), quiet(300), tone(800), quiet(1000))) as { type: string }[];
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
  });

  it("coupe une phrase trop longue", () => {
    const ep = new Endpointer({ maxUtteranceMs: 3000 });
    const events = feed(ep, tone(4000)) as { type: string; audio?: Int16Array }[];
    expect(events.map((e) => e.type)).toEqual(["start", "end", "start"]);
    expect(events[1].audio!.length).toBeLessThanOrEqual(3 * CALL_SAMPLE_RATE + FRAME);
  });
});

describe("speechChunks", () => {
  it("découpe en phrases, la première courte pour parler vite", () => {
    const chunks = speechChunks("Bonjour ! Le gravier 5/15 est à 25 000 FCFA la tonne. Je vous le livre à Yopougon demain ? Dites-moi la quantité.");
    expect(chunks[0]).toBe("Bonjour !");
    expect(chunks.join(" ")).toContain("25000 francs CFA");
    expect(chunks.every((c) => c.length <= 220)).toBe(true);
  });

  it("rend une liste vide pour un texte vide", () => {
    expect(speechChunks("  👍 ")).toEqual([]);
  });
});

function session(overrides: Partial<CallDeps> = {}, options = {}) {
  const sent: ServerMessage[] = [];
  const asked: string[] = [];
  let clock = 0;
  const deps: CallDeps = {
    transcribe: async () => "Je veux 100 poussins",
    think: async (text) => {
      asked.push(text);
      return [
        { type: "text", text: "Très bien ! Pour quelle date ? Je note votre commande." },
        { type: "image", url: "https://x/p.jpg" },
      ];
    },
    speak: async (text) => `mp3:${text}`,
    send: (m) => sent.push(m),
    now: () => clock,
    ...overrides,
  };
  const call = new CallSession(deps, options);
  return { call, sent, asked, advance: (ms: number) => (clock += ms) };
}

describe("CallSession", () => {
  it("écoute, comprend, répond et parle, phrase par phrase", async () => {
    const { call, sent, asked } = session();
    call.start();
    feed(call, concat(quiet(300), tone(1000), quiet(1000)));
    await call.idle();

    expect(asked).toEqual(["Je veux 100 poussins"]);
    const types = sent.map((m) => m.type);
    expect(types[0]).toBe("ready");
    expect(sent).toContainEqual({ type: "heard", text: "Je veux 100 poussins" });
    expect(sent).toContainEqual({ type: "replies", replies: expect.arrayContaining([{ type: "image", url: "https://x/p.jpg" }]) });
    const audio = sent.filter((m) => m.type === "audio") as { data: string }[];
    expect(audio.map((a) => a.data)).toEqual(["mp3:Très bien !", "mp3:Pour quelle date ? Je note votre commande."]);
    expect(types.indexOf("spoken")).toBeGreaterThan(types.lastIndexOf("audio"));
    expect(sent.find((m) => m.type === "timing")).toMatchObject({ stt: expect.any(Number), brain: expect.any(Number) });
  });

  it("n'appelle pas le modèle quand la transcription est vide", async () => {
    const { call, sent, asked } = session({ transcribe: async () => "  " });
    call.start();
    feed(call, concat(tone(1000), quiet(1000)));
    await call.idle();
    expect(asked).toEqual([]);
    expect(sent.at(-1)).toEqual({ type: "state", state: "listening" });
  });

  it("demande de répéter quand la transcription échoue", async () => {
    const { call, sent, asked } = session({
      transcribe: async () => {
        throw new Error("Whisper indisponible");
      },
    });
    call.start();
    feed(call, concat(tone(1000), quiet(1000)));
    await call.idle();
    expect(asked).toEqual([]);
    const audio = sent.filter((m) => m.type === "audio") as { data: string }[];
    expect(audio[0].data).toMatch(/^mp3:Je n'ai pas bien entendu/);
  });

  it("se tait dès que le client l'interrompt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spoken: string[] = [];
    const { call, sent } = session({
      speak: async (text) => {
        spoken.push(text);
        if (spoken.length === 1) await gate;
        return `mp3:${text}`;
      },
    });
    call.start();
    feed(call, concat(tone(1000), quiet(1000)));
    await new Promise((r) => setTimeout(r, 0));
    call.control({ type: "interrupt" });
    release();
    await call.idle();
    expect(sent.filter((m) => m.type === "audio")).toEqual([]);
    expect(spoken).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ type: "state", state: "listening" });
  });

  it("raccroche après un long silence et après le nombre maximal d'échanges", async () => {
    const quietCall = session({}, { idleMs: 5000 });
    quietCall.call.start();
    quietCall.advance(6000);
    feed(quietCall.call, quiet(200));
    expect(quietCall.sent.at(-1)).toEqual({ type: "end", reason: "silence" });

    const busy = session({}, { maxTurns: 1 });
    busy.call.start();
    feed(busy.call, concat(tone(1000), quiet(1000)));
    await busy.call.idle();
    expect(busy.sent.at(-1)).toEqual({ type: "end", reason: "turns" });
    feed(busy.call, concat(tone(1000), quiet(1000)));
    await busy.call.idle();
    expect(busy.asked).toHaveLength(1);
  });

  it("continue de parler même si une phrase ne se synthétise pas", async () => {
    let n = 0;
    const { call, sent } = session({
      speak: async (text) => (n++ === 0 ? null : `mp3:${text}`),
    });
    call.start();
    feed(call, concat(tone(1000), quiet(1000)));
    await call.idle();
    expect((sent.filter((m) => m.type === "audio") as { data: string }[]).map((a) => a.data)).toEqual([
      "mp3:Pour quelle date ? Je note votre commande.",
    ]);
  });
});
