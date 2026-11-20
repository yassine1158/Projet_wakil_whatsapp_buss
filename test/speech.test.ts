import { describe, expect, it } from "vitest";
import { elevenLabsSpeaker, speakerFor } from "../src/speech";
import type { Env } from "../src/types";

function fakeFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const freeAi = { run: async () => ({ audio: "TUVMTw==" }) } as unknown as Ai;

describe("elevenLabsSpeaker", () => {
  it("demande un MP3 en français avec la clé, et le rend en base64", async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const audio = await elevenLabsSpeaker(" KEY \n", { voiceId: "VOIX" }, fn)("Bonjour, je vous écoute.");
    expect(audio).toBe("AQID");
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech/VOIX?output_format=mp3_44100_64");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("KEY");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      text: "Bonjour, je vous écoute.",
      model_id: "eleven_flash_v2_5",
      language_code: "fr",
      apply_text_normalization: "on",
    });
  });

  it("n'envoie pas language_code au modèle multilingual_v2, qui le refuse", async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([1])));
    await elevenLabsSpeaker("KEY", { model: "eleven_multilingual_v2" }, fn)("Bonjour");
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty("language_code");
  });

  it("signale une erreur d'ElevenLabs", async () => {
    const { fn } = fakeFetch(() => new Response('{"detail":"quota_exceeded"}', { status: 401 }));
    await expect(elevenLabsSpeaker("KEY", {}, fn)("Bonjour")).rejects.toThrow(/ElevenLabs 401.*quota_exceeded/);
  });
});

describe("speakerFor", () => {
  it("prend la voix gratuite de Workers AI sans clé ElevenLabs", async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([1])));
    expect(await speakerFor({ AI: freeAi } as Env, fn)("Bonjour")).toBe("TUVMTw==");
    expect(calls).toHaveLength(0);
  });

  it("prend ElevenLabs avec la clé, et la voix gratuite si ElevenLabs échoue", async () => {
    let fail = false;
    const { fn } = fakeFetch(() => (fail ? new Response("down", { status: 503 }) : new Response(new Uint8Array([1, 2, 3]))));
    const speak = speakerFor({ AI: freeAi, ELEVENLABS_API_KEY: "KEY" } as Env, fn, () => {});
    expect(await speak("Bonjour")).toBe("AQID");
    fail = true;
    expect(await speak("Bonjour")).toBe("TUVMTw==");
  });
});
