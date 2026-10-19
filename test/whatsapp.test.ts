import { describe, expect, it } from "vitest";
import { bytesToHex } from "../src/encoding";
import { parseWebhook, splitForWhatsApp, verifySignature, WhatsAppClient, WhatsAppError } from "../src/whatsapp";

async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${bytesToHex(new Uint8Array(mac))}`;
}

const webhook = (messages: unknown[], contacts: unknown[] = []) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PNID" }, contacts, messages },
        },
      ],
    },
  ],
});

describe("verifySignature", () => {
  it("accepte une signature valide et refuse le reste", async () => {
    const body = '{"hello":"world"}';
    const header = await sign(body, "secret");
    expect(await verifySignature(body, header, "secret")).toBe(true);
    expect(await verifySignature(body + " ", header, "secret")).toBe(false);
    expect(await verifySignature(body, header, "autre")).toBe(false);
    expect(await verifySignature(body, null, "secret")).toBe(false);
  });
});

describe("parseWebhook", () => {
  it("normalise texte, vocal, photo et position", () => {
    const out = parseWebhook(
      webhook(
        [
          { id: "m1", from: "225070", timestamp: "1700000000", type: "text", text: { body: "Bonjour" } },
          { id: "m2", from: "225070", timestamp: "1700000001", type: "audio", audio: { id: "a1", mime_type: "audio/ogg; codecs=opus" } },
          { id: "m3", from: "225070", timestamp: "1700000002", type: "image", image: { id: "i1", mime_type: "image/jpeg", caption: "mon chantier" } },
          { id: "m4", from: "225070", timestamp: "1700000003", type: "location", location: { latitude: 5.33, longitude: -4.08, name: "Yopougon" } },
          { id: "m5", from: "225070", timestamp: "1700000004", type: "reaction", reaction: { emoji: "👍" } },
          { id: "m6", from: "225070", timestamp: "1700000005", type: "sticker", sticker: { id: "s1" } },
        ],
        [{ wa_id: "225070", profile: { name: "Kouassi" } }],
      ),
    );
    expect(out.map((o) => o.message.kind)).toEqual(["text", "audio", "image", "location", "unsupported"]);
    expect(out[0]).toMatchObject({ phoneNumberId: "PNID", message: { text: "Bonjour", name: "Kouassi", timestamp: 1700000000000 } });
    expect(out[1].message).toMatchObject({ mediaId: "a1" });
    expect(out[2].message).toMatchObject({ mediaId: "i1", text: "mon chantier" });
    expect(out[3].message.location).toMatchObject({ latitude: 5.33, name: "Yopougon" });
  });

  it("ignore les notifications de statut", () => {
    const payload = { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "P" }, statuses: [{ id: "x" }] } }] }] };
    expect(parseWebhook(payload)).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
  });
});

describe("splitForWhatsApp", () => {
  it("découpe sur les sauts de ligne sous la limite", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    const parts = splitForWhatsApp(text, 100);
    expect(parts).toEqual(["a".repeat(60), "b".repeat(60)]);
    expect(splitForWhatsApp("court")).toEqual(["court"]);
  });
});

describe("WhatsAppClient", () => {
  it("envoie un texte avec le bon format et le jeton", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await new WhatsAppClient("TOKEN", "PNID", "v23.0", fake).sendText("225070", "Bonjour");
    expect(calls[0].url).toBe("https://graph.facebook.com/v23.0/PNID/messages");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "225070",
      type: "text",
      text: { body: "Bonjour", preview_url: false },
    });
  });

  it("remonte le code d'erreur de Meta", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ error: { message: "Re-engagement message", code: 131047 } }), { status: 400 })) as unknown as typeof fetch;
    const err = await new WhatsAppClient("T", "P", "v23.0", fake).sendText("1", "x").catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppError);
    expect(err.code).toBe(131047);
  });
});
