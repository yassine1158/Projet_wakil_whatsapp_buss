import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { handleChat } from "../src/web";

const SITE = "https://yassine1158.github.io";
const SESSION = "abcdefgh12345678abcd";

function fakeEnv(limited = false) {
  const calls: { name: string; args: unknown[] }[] = [];
  const env = {
    CONVERSATIONS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        chat: async (...args: unknown[]) => {
          calls.push({ name, args });
          return [{ type: "text", text: "Bonjour !" }];
        },
      }),
    },
    CHAT_LIMITER: { limit: async () => ({ success: !limited }) },
  } as unknown as Env;
  return { env, calls };
}

const post = (body: unknown, origin: string | null = SITE) =>
  new Request("https://wakil.example/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const call = (req: Request, env: Env) => handleChat(req, env, new URL(req.url));

describe("POST /chat", () => {
  it("transmet le message à la conversation du visiteur", async () => {
    const { env, calls } = fakeEnv();
    const res = await call(post({ tenant: "sicar", session: SESSION, text: "  Bonjour  " }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(await res.json()).toEqual({ replies: [{ type: "text", text: "Bonjour !" }] });
    expect(calls).toEqual([{ name: `web:sicar:${SESSION}`, args: ["REMPLACER_PAR_PHONE_NUMBER_ID", SESSION, "Bonjour"] }]);
  });

  it("refuse un site non autorisé ou une entreprise inconnue", async () => {
    const { env, calls } = fakeEnv();
    expect((await call(post({ tenant: "sicar", session: SESSION, text: "x" }, "https://pirate.example"), env)).status).toBe(403);
    expect((await call(post({ tenant: "sicar", session: SESSION, text: "x" }, null), env)).status).toBe(403);
    expect((await call(post({ tenant: "autre", session: SESSION, text: "x" }), env)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("refuse une requête mal formée", async () => {
    const { env } = fakeEnv();
    expect((await call(post("pas du json"), env)).status).toBe(400);
    expect((await call(post({ tenant: "sicar", session: "court", text: "x" }), env)).status).toBe(400);
    expect((await call(post({ tenant: "sicar", session: SESSION, text: "   " }), env)).status).toBe(400);
    expect((await call(post({ tenant: "sicar", session: SESSION, text: "a".repeat(1001) }), env)).status).toBe(400);
  });

  it("limite le débit par adresse IP", async () => {
    const { env, calls } = fakeEnv(true);
    expect((await call(post({ tenant: "sicar", session: SESSION, text: "x" }), env)).status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /chat/config et pré-vérification CORS", () => {
  it("donne les noms au site autorisé seulement", async () => {
    const { env } = fakeEnv();
    const req = (origin: string) =>
      new Request("https://wakil.example/chat/config?tenant=sicar", { headers: { origin } });
    const ok = await call(req(SITE), env);
    expect(await ok.json()).toEqual({ businessName: "SICAR SARL", assistantName: "Wakil" });
    expect((await call(req("https://pirate.example"), env)).status).toBe(403);
  });

  it("répond au preflight pour un site connu", async () => {
    const { env } = fakeEnv();
    const preflight = (origin: string) =>
      call(new Request("https://wakil.example/chat", { method: "OPTIONS", headers: { origin } }), env);
    expect((await preflight(SITE)).headers.get("access-control-allow-origin")).toBe(SITE);
    expect((await preflight("https://pirate.example")).headers.get("access-control-allow-origin")).toBeNull();
  });
});
