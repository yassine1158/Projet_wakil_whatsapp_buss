import { describe, expect, it } from "vitest";
import { callTranscriber, FAST_STT_MODEL } from "../src/call/stt";

function fakeAi(models: Record<string, (input: any) => unknown>) {
  const calls: { model: string; input: any }[] = [];
  const ai = {
    async run(model: string, input: any) {
      calls.push({ model, input });
      return models[model](input);
    },
  } as unknown as Ai;
  return { ai, calls };
}

const WAV = new Uint8Array([82, 73, 70, 70]);
const nova = (text: string) => ({ results: { channels: [{ alternatives: [{ transcript: text }] }] } });

describe("callTranscriber", () => {
  it("transcrit avec Nova-3 en français", async () => {
    const { ai, calls } = fakeAi({ [FAST_STT_MODEL]: () => nova(" Je veux 100 poussins. ") });
    expect(await callTranscriber(ai, "Poussin")(WAV)).toBe("Je veux 100 poussins.");
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({ language: "fr", audio: { contentType: "audio/wav" } });
    expect(calls[0].input.audio.body).toBeInstanceOf(ReadableStream);
  });

  it("passe à Whisper si Nova-3 échoue ou ne rend rien", async () => {
    const logs: string[] = [];
    const failing = fakeAi({
      [FAST_STT_MODEL]: () => {
        throw new Error("5007: model not found");
      },
      "@cf/openai/whisper-large-v3-turbo": () => ({ text: "Bonjour" }),
    });
    expect(await callTranscriber(failing.ai, "", (m) => logs.push(m))(WAV)).toBe("Bonjour");
    expect(logs[0]).toMatch(/Nova-3 échoué.*5007/);

    const empty = fakeAi({ [FAST_STT_MODEL]: () => nova(""), "@cf/openai/whisper-large-v3-turbo": () => ({ text: "Bonsoir" }) });
    expect(await callTranscriber(empty.ai, "")(WAV)).toBe("Bonsoir");
  });
});
