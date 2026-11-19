import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { parseTenantInput } from "../src/companies";
import { buildSystemPrompt } from "../src/prompt";
import type { Tenant } from "../src/types";
import { handleVoice, NOT_HEARD_REPLY, speakable, VOICE_PREFIX, type VoiceDeps } from "../src/voice";

const SITE = "https://yassine1158.github.io";
const SESSION = "abcdefgh12345678abcd";

describe("speakable", () => {
  it("retire émojis, liens et mise en forme", () => {
    expect(speakable("Bonjour 👋 *Gravier* disponible ! Voir https://x.ci/p")).toBe("Bonjour Gravier disponible ! Voir.");
  });

  it("rend les listes, unités et nombres faciles à dire", () => {
    expect(speakable("Il vous faut :\n• 3 m3 de gravier 5/15\n• 2 m² de sable\nSoit 25 000 FCFA")).toBe(
      "Il vous faut : 3 mètres cubes de gravier 5 15. 2 mètres carrés de sable. Soit 25000 francs CFA.",
    );
    expect(speakable("1.250.000 F CFA, 40 kg")).toBe("1250000 francs CFA, 40 kilos.");
  });

  it("coupe un texte trop long à la fin d'une phrase", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Phrase numéro ${i} du devis.`).join(" ");
    const out = speakable(long);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith(".")).toBe(true);
  });
});

function setup(options: { transcript?: string; transcribeFails?: boolean; speakFails?: boolean; limited?: boolean } = {}) {
  const chats: unknown[][] = [];
  const spoken: string[] = [];
  const env = {
    CONVERSATIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        chat: async (...args: unknown[]) => {
          chats.push(args);
          return [
            { type: "text", text: "Oui 👍 le *gravier 5/15* est disponible." },
            { type: "image", url: "https://x/g.jpg" },
          ];
        },
      }),
    },
    CHAT_LIMITER: { limit: async () => ({ success: !options.limited }) },
    INBOX: { idFromName: (n: string) => n, get: () => ({ listTenants: async () => [] }) },
  } as unknown as Env;
  const deps: VoiceDeps = {
    transcribe: async () => {
      if (options.transcribeFails) throw new Error("format");
      return options.transcript ?? " Vous avez du gravier ? ";
    },
    speak: async (text) => {
      if (options.speakFails) throw new Error("tts");
      spoken.push(text);
      return "TVAzLWF1ZGlv";
    },
    hint: async () => "Gravier 5/15",
  };
  return { env, deps, chats, spoken };
}

const post = (origin: string | null = SITE, body: BodyInit = new Uint8Array([1, 2, 3]), session = SESSION) =>
  new Request(`https://wakil.example/voice?tenant=sicar&session=${session}`, {
    method: "POST",
    headers: { "content-type": "audio/webm", ...(origin ? { origin } : {}) },
    body,
  });

const call = (req: Request, env: Env, deps: VoiceDeps) => handleVoice(req, env, new URL(req.url), deps);

describe("POST /voice", () => {
  it("transcrit, passe par la même conversation que le chat et renvoie la réponse dite", async () => {
    const { env, deps, chats, spoken } = setup();
    const res = await call(post(), env, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    const data: any = await res.json();
    expect(data.transcript).toBe("Vous avez du gravier ?");
    expect(data.replies).toHaveLength(2);
    expect(data.audio).toBe("TVAzLWF1ZGlv");
    expect(chats).toEqual([["sicar", SESSION, `${VOICE_PREFIX}Vous avez du gravier ?`]]);
    expect(spoken).toEqual(["Oui le gravier 5 15 est disponible."]);
  });

  it("demande de répéter quand rien n'a été compris, sans déranger la conversation", async () => {
    const { env, deps, chats } = setup({ transcript: "   " });
    const data: any = await (await call(post(), env, deps)).json();
    expect(data.replies).toEqual([{ type: "text", text: NOT_HEARD_REPLY }]);
    expect(data.audio).toBe("TVAzLWF1ZGlv");
    expect(chats).toHaveLength(0);
  });

  it("renvoie le texte même si la synthèse vocale échoue", async () => {
    const { env, deps } = setup({ speakFails: true });
    const data: any = await (await call(post(), env, deps)).json();
    expect(data.replies[0].text).toContain("gravier");
    expect(data.audio).toBeNull();
  });

  it("signale un enregistrement impossible à transcrire", async () => {
    const { env, deps, chats } = setup({ transcribeFails: true });
    expect((await call(post(), env, deps)).status).toBe(422);
    expect(chats).toHaveLength(0);
  });

  it("refuse un site non autorisé, une session invalide, un fichier vide ou trop gros, un abus", async () => {
    const { env, deps, chats } = setup();
    expect((await call(post("https://pirate.example"), env, deps)).status).toBe(403);
    expect((await call(post(null), env, deps)).status).toBe(403);
    expect((await call(post(SITE, new Uint8Array([1]), "court"), env, deps)).status).toBe(400);
    expect((await call(post(SITE, new Uint8Array([])), env, deps)).status).toBe(400);
    expect((await call(post(SITE, new Uint8Array(2_000_001)), env, deps)).status).toBe(413);
    expect((await call(post(), setup({ limited: true }).env, deps)).status).toBe(429);
    expect(chats).toHaveLength(0);
  });
});

describe("réponses vocales sur WhatsApp : réglage et prompt", () => {
  const company = { id: "acme", businessName: "Acme", catalog: { products: [] } };

  it("garde le réglage choisi dans l'application, « après un vocal » par défaut", () => {
    expect((parseTenantInput({ ...company, voiceReplies: "always" }) as Tenant).voiceReplies).toBe("always");
    expect((parseTenantInput({ ...company, voiceReplies: "never" }) as Tenant).voiceReplies).toBe("never");
    expect((parseTenantInput({ ...company, voiceReplies: "after-voice" }) as Tenant).voiceReplies).toBeUndefined();
    expect((parseTenantInput({ ...company, voiceReplies: "n'importe quoi" }) as Tenant).voiceReplies).toBeUndefined();
  });

  it("prévient le modèle que sa réponse sera dite, sur WhatsApp seulement", () => {
    const tenant = parseTenantInput(company) as Tenant;
    const catalog = { products: [], info: { faq: [] } };
    expect(buildSystemPrompt(tenant, catalog, "whatsapp")).toContain("Quand le client envoie un vocal, ta réponse est aussi envoyée au client en message vocal");
    expect(buildSystemPrompt({ ...tenant, voiceReplies: "always" }, catalog, "whatsapp")).toContain("À chaque message, ta réponse est aussi envoyée");
    expect(buildSystemPrompt({ ...tenant, voiceReplies: "never" }, catalog, "whatsapp")).not.toContain("message vocal");
    expect(buildSystemPrompt(tenant, catalog, "web")).not.toContain("en message vocal");
  });
});
