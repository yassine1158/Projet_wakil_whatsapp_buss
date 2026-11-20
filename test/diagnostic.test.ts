import { describe, expect, it } from "vitest";
import { checkWhatsApp, explainError } from "../src/diagnostic";

describe("explication des erreurs de Claude", () => {
  it("dit quoi faire selon l'erreur", () => {
    expect(explainError(401, "authentication_error", "invalid x-api-key")).toContain("ANTHROPIC_API_KEY");
    expect(explainError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")).toContain("Billing");
    expect(explainError(404, "not_found_error", "model: x")).toContain("CLAUDE_MODEL");
    expect(explainError(429, "rate_limit_error", "")).toContain("minute");
    expect(explainError(529, "overloaded_error", "")).toContain("surchargé");
    expect(explainError(undefined, undefined, "fetch failed")).toContain("Connexion");
  });
});

describe("vérification de la connexion à WhatsApp", () => {
  const tenant = { id: "sana", whatsapp: { phoneNumberId: "PN1" } } as any;
  const env = { WHATSAPP_TOKEN: "EAAjeton\n" } as any;
  const answer = (status: number, body: unknown) => {
    const calls: { url: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  it("confirme le numéro avec le jeton nettoyé, et rappelle la règle des numéros de test", async () => {
    const { calls, fetchFn } = answer(200, { display_phone_number: "+1 555-188-4409", verified_name: "Test Number", quality_rating: "GREEN" });
    const d = await checkWhatsApp(env, tenant, null, fetchFn);
    expect(calls[0].url).toContain("/PN1?fields=");
    expect(calls[0].auth).toBe("Bearer EAAjeton");
    expect(d.ok).toBe(true);
    expect(d.message).toContain("+1 555-188-4409");
    expect(d.message).toContain("Destinataire");
    expect(d.message).toContain("espaces en trop");
  });

  it("explique un jeton expiré ou sans accès, et dit quel jeton a servi", async () => {
    const expired = await checkWhatsApp(env, tenant, null, answer(401, { error: { code: 190, message: "Session has expired" } }).fetchFn);
    expect(expired).toMatchObject({ ok: false, detail: "401 190 Session has expired (secret WHATSAPP_TOKEN)" });
    expect(expired.message).toContain("WHATSAPP_TOKEN");
    const denied = await checkWhatsApp(env, tenant, "EAApropre", answer(403, { error: { code: 200, message: "Permissions error" } }).fetchFn);
    expect(denied.message).toContain("utilisateur système");
    expect(denied.detail).toContain("jeton propre à l'entreprise");
  });

  it("sans numéro ou sans jeton, dit quoi faire sans appeler Meta", async () => {
    const { calls, fetchFn } = answer(200, {});
    expect((await checkWhatsApp(env, { id: "x" } as any, null, fetchFn)).message).toContain("Aucun numéro");
    expect((await checkWhatsApp({} as any, tenant, null, fetchFn)).message).toContain("Aucun jeton");
    expect(calls).toHaveLength(0);
  });
});
