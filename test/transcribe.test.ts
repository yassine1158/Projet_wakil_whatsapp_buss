import { describe, expect, it } from "vitest";
import { MAX_HINT_LENGTH, workersAiTranscriber } from "../src/transcribe";

/** Faux Workers AI : chaque modèle répond selon la fonction prévue, et les appels sont gardés. */
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

const AUDIO = new Uint8Array([1, 2, 3]);

describe("workersAiTranscriber", () => {
  it("envoie le vocal en base64 à Whisper turbo, avec un indice court", async () => {
    const { ai, calls } = fakeAi({ "@cf/openai/whisper-large-v3-turbo": () => ({ text: " Bonjour, je veux 100 poussins " }) });
    const text = await workersAiTranscriber(ai)(AUDIO, "audio/ogg; codecs=opus", "Poussin chair, ".repeat(200));
    expect(text).toBe("Bonjour, je veux 100 poussins");
    expect(calls).toHaveLength(1);
    expect(calls[0].input.audio).toBe("AQID");
    expect(calls[0].input.initial_prompt.length).toBeLessThanOrEqual(MAX_HINT_LENGTH);
  });

  it("n'envoie pas d'indice vide", async () => {
    const { ai, calls } = fakeAi({ "@cf/openai/whisper-large-v3-turbo": () => ({ text: "Bonjour" }) });
    await workersAiTranscriber(ai)(AUDIO, "audio/ogg", "");
    expect(calls[0].input).not.toHaveProperty("initial_prompt");
  });

  it("passe à l'ancien Whisper si turbo échoue", async () => {
    const { ai, calls } = fakeAi({
      "@cf/openai/whisper-large-v3-turbo": () => {
        throw new Error("3010: Invalid input");
      },
      "@cf/openai/whisper": () => ({ text: " Bonjour " }),
    });
    expect(await workersAiTranscriber(ai)(AUDIO, "audio/ogg", "Poussin")).toBe("Bonjour");
    expect(calls.map((c) => c.model)).toEqual(["@cf/openai/whisper-large-v3-turbo", "@cf/openai/whisper"]);
    expect(calls[1].input.audio).toEqual([1, 2, 3]);
  });

  it("donne la cause de chaque échec quand aucun Whisper ne marche", async () => {
    const { ai } = fakeAi({
      "@cf/openai/whisper-large-v3-turbo": () => {
        throw new Error("3010: Invalid input");
      },
      "@cf/openai/whisper": () => {
        throw new Error("3040: Capacity temporarily exceeded");
      },
    });
    const err = await workersAiTranscriber(ai)(AUDIO, "audio/ogg", "").catch((e) => e);
    expect(err.message).toContain("3010: Invalid input");
    expect(err.message).toContain("3040: Capacity temporarily exceeded");
  });
});
