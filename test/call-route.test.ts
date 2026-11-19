import { describe, expect, it } from "vitest";
import { callRoom, handleCall } from "../src/call/route";
import type { Env } from "../src/types";

const SITE = "https://yassine1158.github.io";
const SESSION = "abcdefgh12345678abcd";

function setup(limited = false) {
  const rooms: { name: string; url: string }[] = [];
  const env = {
    CALLS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (req: Request) => {
          rooms.push({ name, url: req.url });
          return new Response("salle");
        },
      }),
    },
    CHAT_LIMITER: { limit: async () => ({ success: !limited }) },
    INBOX: { idFromName: (n: string) => n, get: () => ({ listTenants: async () => [] }) },
  } as unknown as Env;
  return { env, rooms };
}

const open = (headers: Record<string, string> = { upgrade: "websocket", origin: SITE }, session = SESSION) =>
  new Request(`https://wakil.example/call?tenant=sicar&session=${session}`, { headers });

const call = (req: Request, env: Env) => handleCall(req, env, new URL(req.url));

describe("GET /call", () => {
  it("ouvre la salle d'appel du visiteur", async () => {
    const { env, rooms } = setup();
    const res = await call(open(), env);
    expect(await res.text()).toBe("salle");
    expect(rooms).toEqual([{ name: callRoom("sicar", SESSION), url: open().url }]);
  });

  it("exige un WebSocket", async () => {
    const { env } = setup();
    expect((await call(open({ origin: SITE }), env)).status).toBe(426);
  });

  it("refuse un site non déclaré, une session invalide et l'excès d'appels", async () => {
    expect((await call(open({ upgrade: "websocket", origin: "https://pirate.example" }), setup().env)).status).toBe(403);
    expect((await call(open({ upgrade: "websocket" }), setup().env)).status).toBe(403);
    expect((await call(open(undefined, "court"), setup().env)).status).toBe(400);
    expect((await call(open(), setup(true).env)).status).toBe(429);
  });
});
