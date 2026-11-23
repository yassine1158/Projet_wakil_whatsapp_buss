import { describe, expect, it } from "vitest";
import { completeWhatsappSignup } from "../src/companies";
import { parseEchoes, parseWebhook } from "../src/whatsapp";

function fakeMeta(fail: (url: string) => boolean = () => false) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (fail(u)) return new Response(JSON.stringify({ error: { message: "refusé" } }), { status: 400 });
    if (u.includes("/oauth/access_token")) return Response.json({ access_token: "BUSINESS_TOKEN" });
    if (u.includes("/phone_numbers")) return Response.json({ data: [{ id: "PN777" }] });
    if (u.includes("fields=display_phone_number")) return Response.json({ display_phone_number: "+225 07 11 22 33 44" });
    return Response.json({ success: true });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const base = { appId: "APP", appSecret: "SECRET", apiVersion: "v23.0", code: "CODE", wabaId: "WABA1" };
const path = (u: string) => new URL(u).pathname.replace("/v23.0/", "") + (new URL(u).searchParams.get("fields") ? "?fields" : "");

describe("inscription intégrée de Meta", () => {
  it("numéro neuf : abonnement aux messages puis enregistrement avec un code", async () => {
    const { calls, fetchFn } = fakeMeta();
    const r = await completeWhatsappSignup({ ...base, phoneNumberId: "PN1" }, fetchFn);
    expect(calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual([
      "GET oauth/access_token", "POST WABA1/subscribed_apps", "POST PN1/register", "GET PN1?fields",
    ]);
    expect(calls[2].body.pin).toMatch(/^\d{6}$/);
    expect(r).toMatchObject({ token: "BUSINESS_TOKEN", phoneNumberId: "PN1", displayPhone: "+225 07 11 22 33 44" });
    expect(r.pin).toBe(calls[2].body.pin);
  });

  it("numéro de l'application WhatsApp Business : pas de réenregistrement, synchronisation des contacts puis de l'historique", async () => {
    const { calls, fetchFn } = fakeMeta();
    const r = await completeWhatsappSignup({ ...base, coexistence: true }, fetchFn);
    expect(calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual([
      "GET oauth/access_token", "POST WABA1/subscribed_apps", "GET WABA1/phone_numbers?fields",
      "POST PN777/smb_app_data", "POST PN777/smb_app_data", "GET PN777?fields",
    ]);
    expect(calls.filter((c) => c.url.includes("smb_app_data")).map((c) => c.body.sync_type)).toEqual(["smb_app_state_sync", "history"]);
    expect(calls.some((c) => c.url.includes("/register"))).toBe(false);
    expect(r).toMatchObject({ pin: null, phoneNumberId: "PN777" });
    expect(r.syncError).toBeUndefined();
  });

  it("une synchronisation refusée n'empêche pas la connexion, mais elle est signalée", async () => {
    const { fetchFn } = fakeMeta((u) => u.includes("smb_app_data"));
    const r = await completeWhatsappSignup({ ...base, phoneNumberId: "PN2", coexistence: true }, fetchFn);
    expect(r).toMatchObject({ phoneNumberId: "PN2", syncError: "refusé" });
  });
});

describe("échos de l'application WhatsApp Business", () => {
  const payload = {
    entry: [{ changes: [{
      field: "smb_message_echoes",
      value: {
        metadata: { phone_number_id: "PN777", display_phone_number: "2250711223344" },
        message_echoes: [
          { from: "2250711223344", to: "2250102030405", id: "wamid.1", timestamp: "1800000000", type: "text", text: { body: "Je vous appelle tout de suite" } },
          { from: "2250711223344", to: "2250102030405", id: "wamid.2", timestamp: "1800000060", type: "image", image: { caption: "Le gravier 5/15" } },
          { from: "2250711223344", id: "wamid.3", timestamp: "1800000120", type: "audio", audio: {} },
        ],
      },
    }] }],
  };

  it("lit ce que le patron a répondu, sans en faire des messages de clients", () => {
    expect(parseEchoes(payload)).toEqual([
      { phoneNumberId: "PN777", to: "2250102030405", id: "wamid.1", text: "Je vous appelle tout de suite", timestamp: 1_800_000_000_000 },
      { phoneNumberId: "PN777", to: "2250102030405", id: "wamid.2", text: "Le gravier 5/15", timestamp: 1_800_000_060_000 },
      { phoneNumberId: "PN777", id: "wamid.3", text: "[Vocal]", timestamp: 1_800_000_120_000 },
    ]);
    expect(parseWebhook(payload)).toEqual([]);
  });
});
