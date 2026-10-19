import { describe, expect, it } from "vitest";
import { formatLead, handleLead, parseLead, type Lead } from "../src/leads";
import type { Env } from "../src/types";

const SITE = "https://wakil.example";

function fakeEnv(limited = false) {
  const saved: Lead[] = [];
  const env = {
    INBOX: {
      idFromName: (n: string) => n,
      get: () => ({ addLead: async (l: Lead) => void saved.push(l) }),
    },
    CHAT_LIMITER: { limit: async () => ({ success: !limited }) },
  } as unknown as Env;
  return { env, saved };
}

const post = (body: unknown, origin: string | null = SITE) =>
  new Request(`${SITE}/leads`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
const call = (req: Request, env: Env) => handleLead(req, env, new URL(req.url));
const good = { name: "Awa", company: "Quincaillerie du Plateau", sector: "Quincaillerie", city: "Abidjan", phone: "+225 07 01 02 03 04", message: "" };

describe("formulaire « Essayer Wakil »", () => {
  it("enregistre une demande valide", async () => {
    const { env, saved } = fakeEnv();
    const res = await call(post(good), env);
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ company: "Quincaillerie du Plateau", phone: "2250701020304" });
  });

  it("exige l'indicatif du pays et les champs obligatoires", () => {
    expect(parseLead({ ...good, phone: "07 01 02 03 04" }, 0)).toEqual({ error: "invalid_phone" });
    expect(parseLead({ ...good, company: " " }, 0)).toEqual({ error: "missing_fields" });
    expect(parseLead({ ...good, message: "x".repeat(1001) }, 0)).toEqual({ error: "too_long" });
  });

  it("refuse un autre site, ignore les robots et limite le débit", async () => {
    const a = fakeEnv();
    expect((await call(post(good, "https://pirate.example"), a.env)).status).toBe(403);
    expect((await call(post({ ...good, website: "spam" }), a.env)).status).toBe(200);
    expect(a.saved).toHaveLength(0);
    const b = fakeEnv(true);
    expect((await call(post(good), b.env)).status).toBe(429);
  });

  it("met en forme la notification", () => {
    const text = formatLead({ ...good, createdAt: 0, phone: "2250701020304" });
    expect(text).toContain("Entreprise : Quincaillerie du Plateau");
    expect(text).toContain("https://wa.me/2250701020304");
    expect(text).not.toContain("Message :");
  });
});
