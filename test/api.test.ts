import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api";
import type { StoredTenant, TenantSecrets } from "../src/inbox-types";
import { invalidateTenants } from "../src/registry";
import type { Env, Tenant } from "../src/types";

/** Boîte de réception en mémoire, avec ce que l'API utilise. */
function fakeInbox() {
  const tenants = new Map<string, { tenant: Tenant; secrets: TenantSecrets }>();
  const conversations = [
    { key: "PN:2250101", tenant: "sicar", lastAt: 1 },
    { key: "PN:2250202", tenant: "quincaillerie", lastAt: 2 },
  ];
  const orders = [
    { reference: "W-A", tenant: "sicar", status: "nouvelle" },
    { reference: "W-B", tenant: "quincaillerie", status: "nouvelle" },
  ];
  return {
    tenants,
    orders,
    async listTenants(): Promise<StoredTenant[]> {
      return [...tenants.values()].map(({ tenant, secrets }) => ({
        tenant,
        hasPassword: !!secrets.passwordHash,
        hasWhatsappToken: !!secrets.whatsappToken,
        updatedAt: 0,
      }));
    },
    async saveTenant(tenant: Tenant) {
      const secrets = tenants.get(tenant.id)?.secrets ?? { passwordHash: null, whatsappToken: null, whatsappPin: null };
      tenants.set(tenant.id, { tenant, secrets });
    },
    async insertTenant(tenant: Tenant) {
      if (tenants.has(tenant.id)) return false;
      tenants.set(tenant.id, { tenant, secrets: { passwordHash: null, whatsappToken: null, whatsappPin: null } });
      return true;
    },
    async deleteTenant(id: string) { return tenants.delete(id); },
    async tenantSecrets(id: string) { return tenants.get(id)?.secrets ?? null; },
    async setTenantPassword(id: string, hash: string) { tenants.get(id)!.secrets.passwordHash = hash; return true; },
    async setTenantWhatsappSecrets(id: string, token: string | null, pin: string | null) {
      Object.assign(tenants.get(id)!.secrets, { whatsappToken: token, whatsappPin: pin });
      return true;
    },
    async overview() { return { newOrders: 1, waitingForTeam: 0, conversationsToday: 1, ordersThisWeek: 1, newLeads: 3 }; },
    async listConversations(tenant: string) { return conversations.filter((c) => c.tenant === tenant); },
    async getConversation(key: string) { return conversations.find((c) => c.key === key) ?? null; },
    async listOrders(tenant: string) { return orders.filter((o) => o.tenant === tenant); },
    async orderTenant(ref: string) { return orders.find((o) => o.reference === ref)?.tenant ?? null; },
    async setOrderStatus(ref: string, status: string) { orders.find((o) => o.reference === ref)!.status = status; return true; },
    async listLeads() { return [{ id: 1, company: "Prospect" }]; },
    leads: [] as unknown[],
    async addLead(lead: unknown) { this.leads.push(lead); },
  };
}

let inbox: ReturnType<typeof fakeInbox>;
let env: Env;

beforeEach(() => {
  invalidateTenants();
  inbox = fakeInbox();
  env = {
    ADMIN_PASSWORD: "admin-secret",
    INBOX: { idFromName: (n: string) => n, get: () => inbox },
    CONVERSATIONS: { idFromName: (n: string) => n, get: () => ({ transcript: async () => ({ log: [], handoffUntil: 0 }) }) },
  } as unknown as Env;
});

async function call(path: string, body?: unknown, token?: string) {
  const req = new Request(`https://wakil.example/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleApi(req, env, new URL(req.url));
  return { status: res.status, data: (await res.json()) as any };
}

const login = async (login: string, password: string) => (await call("login", { login, password })).data.token as string;

const quincaillerie = {
  id: "quincaillerie",
  businessName: "Quincaillerie du Plateau",
  ownerPhone: "07 01 02 03 04",
  defaultCountryCode: "225",
  webOrigins: ["https://quincaillerie.ci/boutique"],
  catalog: { products: [{ name: "Ciment CPJ 45", price: "5 500", unit: "sac" }, { name: "" }] },
};

describe("entreprises et connexions des patrons", () => {
  it("l'administrateur crée une entreprise, son catalogue et l'accès du patron", async () => {
    const admin = await login("admin", "admin-secret");
    const created = await call("companies/new", quincaillerie, admin);
    expect(created.status).toBe(200);
    expect(created.data.tenant).toMatchObject({
      id: "quincaillerie",
      assistantName: "Wakil",
      ownerPhone: "2250701020304",
      webOrigins: ["https://quincaillerie.ci"],
      catalog: { products: [{ id: "ciment-cpj-45", name: "Ciment CPJ 45", price: "5 500", unit: "sac", available: true }] },
    });
    expect((await call("companies/new", quincaillerie, admin)).status).toBe(409);

    expect((await call("companies/quincaillerie/password", { password: "court" }, admin)).status).toBe(400);
    expect((await call("companies/quincaillerie/password", { password: "Clou-Marteau-77" }, admin)).data).toEqual({ ok: true, login: "quincaillerie" });
    expect(inbox.tenants.get("quincaillerie")!.secrets.passwordHash).toMatch(/^pbkdf2\$/);

    const list = await call("companies", undefined, admin);
    expect(list.data.map((c: any) => [c.tenant.id, c.hasPassword])).toEqual(
      expect.arrayContaining([["quincaillerie", true], ["sicar", false]]),
    );
  });

  it("un patron ne voit que son entreprise", async () => {
    const admin = await login("admin", "admin-secret");
    await call("companies/new", quincaillerie, admin);
    await call("companies/quincaillerie/password", { password: "Clou-Marteau-77" }, admin);

    expect((await call("login", { login: "quincaillerie", password: "mauvais" })).status).toBe(401);
    const patron = await login("quincaillerie", "Clou-Marteau-77");
    expect((await call("me", undefined, patron)).data).toMatchObject({ role: "tenant", tenantId: "quincaillerie" });
    expect((await call("tenants", undefined, patron)).data.map((t: any) => t.id)).toEqual(["quincaillerie"]);

    // Même en demandant SICAR, il reçoit les données de sa propre entreprise.
    expect((await call("conversations?tenant=sicar", undefined, patron)).data.map((c: any) => c.key)).toEqual(["PN:2250202"]);
    expect((await call("orders?tenant=sicar", undefined, patron)).data.map((o: any) => o.reference)).toEqual(["W-B"]);
    expect((await call("conversations/PN%3A2250101", undefined, patron)).status).toBe(404);
    expect((await call("orders/W-A", { status: "annulee" }, patron)).status).toBe(404);
    expect(inbox.orders[0].status).toBe("nouvelle");
    expect((await call("orders/W-B", { status: "confirmee" }, patron)).status).toBe(200);

    // Ce qui est réservé à l'administrateur.
    for (const path of ["companies", "leads", "diagnostic"]) expect((await call(path, undefined, patron)).status).toBe(403);
    expect((await call("companies/new", { ...quincaillerie, id: "autre" }, patron)).status).toBe(403);
    expect((await call("overview", undefined, patron)).data.newLeads).toBe(0);
  });

  it("relie un numéro WhatsApp à la main, une seule entreprise par numéro", async () => {
    const admin = await login("admin", "admin-secret");
    await call("companies/new", quincaillerie, admin);
    const linked = await call("companies/quincaillerie/whatsapp", { phoneNumberId: "123456789012345", displayPhone: "+225 07 00" }, admin);
    expect(linked.data.tenant.whatsapp).toEqual({ phoneNumberId: "123456789012345", displayPhone: "+225 07 00" });
    expect((await call("companies/sicar/whatsapp", { phoneNumberId: "123456789012345" }, admin)).status).toBe(409);
    const off = await call("companies/quincaillerie/whatsapp/disconnect", {}, admin);
    expect(off.data.tenant.whatsapp).toBeUndefined();
  });

  it("une entreprise supprimée ne peut plus se connecter", async () => {
    const admin = await login("admin", "admin-secret");
    await call("companies/new", quincaillerie, admin);
    await call("companies/quincaillerie/password", { password: "Clou-Marteau-77" }, admin);
    const patron = await login("quincaillerie", "Clou-Marteau-77");
    await call("companies/quincaillerie/delete", {}, admin);
    expect((await call("overview", undefined, patron)).status).toBe(401);
  });

  it("refuse une fiche incomplète", async () => {
    const admin = await login("admin", "admin-secret");
    expect((await call("companies/new", { ...quincaillerie, businessName: "" }, admin)).data).toEqual({ error: "required", field: "businessName" });
    expect((await call("companies/new", { ...quincaillerie, id: "Avec Espaces" }, admin)).data.field).toBe("id");
    expect((await call("companies/new", { ...quincaillerie, catalog: { productsUrl: "http://pas-https" } }, admin)).data.field).toBe("catalog.productsUrl");
  });
});

describe("inscription en ligne et essai gratuit", () => {
  const DAY = 86_400_000;
  const signup = async (body: Record<string, unknown>, origin: string | null = "https://wakil.example") => {
    const req = new Request("https://wakil.example/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
    const res = await handleApi(req, env, new URL(req.url));
    return { status: res.status, data: (await res.json()) as any };
  };
  const awa = {
    businessName: "Boutique Awa",
    phone: "07 07 07 07 07",
    wakilPhone: "07 08 08 08 08",
    numberFree: true,
    countryCode: "225",
    password: "Pagne-Wax-2026",
    sector: "Commerce",
    catalogText: "Pagne wax 6 yards : 12 000 F",
    infoText: "Ouvert de 8 h à 19 h, Adjamé",
    accept: true,
  };

  it("crée l'entreprise en essai de 14 jours et connecte le patron tout de suite", async () => {
    const before = Date.now();
    const { status, data } = await signup(awa);
    expect(status).toBe(200);
    expect(data.login).toBe("boutique-awa");
    const t = inbox.tenants.get("boutique-awa")!.tenant;
    expect(t).toMatchObject({ businessName: "Boutique Awa", ownerPhone: "2250707070707", timezone: "Africa/Abidjan", defaultCountryCode: "225", catalog: { products: [] } });
    expect(t.hostedNumber).toEqual({ phone: "2250708080808", countryCode: "225", state: "submitted", requestedAt: expect.any(Number) });
    expect(t.instructions).toContain("Pagne wax 6 yards : 12 000 F");
    expect(t.instructions).toContain("Ouvert de 8 h à 19 h, Adjamé");
    expect(t.subscription!.plan).toBe("pro");
    expect(t.subscription!.trialEndsAt! - before).toBeGreaterThanOrEqual(14 * DAY - 1000);
    expect(inbox.leads).toEqual([expect.objectContaining({ company: "Boutique Awa", phone: "2250707070707", sector: "Commerce" })]);

    const tenants = (await call("tenants", undefined, data.token)).data;
    expect(tenants).toEqual([expect.objectContaining({ id: "boutique-awa", subscription: expect.objectContaining({ status: "trial", plan: "pro", daysLeft: 14 }) })]);
    expect(await login("boutique-awa", "Pagne-Wax-2026")).toBeTruthy();
  });

  it("un essai par numéro, un identifiant unique par nom", async () => {
    await signup(awa);
    expect(await signup({ ...awa, businessName: "Autre nom" })).toMatchObject({ status: 409, data: { error: "phone_in_use", field: "phone" } });
    expect((await signup({ ...awa, phone: "+221 77 000 00 01", wakilPhone: "77 000 00 02", countryCode: "221" })).data.login).toBe("boutique-awa-2");
    expect(inbox.tenants.get("boutique-awa-2")!.tenant.timezone).toBe("Africa/Dakar");
    expect((await signup({ ...awa, businessName: "Admin", phone: "0505050505", wakilPhone: "0505050506" })).data.login).toBe("entreprise");
  });

  it("refuse une inscription incomplète, venue d'ailleurs ou d'un robot", async () => {
    expect((await signup({ ...awa, password: "court" })).data).toEqual({ error: "weak_password", field: "password" });
    expect((await signup({ ...awa, accept: false })).data).toEqual({ error: "required", field: "accept" });
    expect((await signup({ ...awa, phone: "12" })).data).toEqual({ error: "invalid_phone", field: "phone" });
    expect((await signup({ ...awa, businessName: " " })).data).toEqual({ error: "required", field: "businessName" });
    expect((await signup({ ...awa, wakilPhone: "" })).data).toEqual({ error: "invalid_phone", field: "wakilPhone" });
    expect((await signup({ ...awa, wakilPhone: awa.phone })).data).toEqual({ error: "same_phone", field: "wakilPhone" });
    expect((await signup({ ...awa, numberFree: false })).data).toEqual({ error: "required", field: "numberFree" });
    expect((await signup(awa, "https://pirate.example")).status).toBe(403);
    expect((await signup(awa, null)).status).toBe(403);
    expect(await signup({ ...awa, website: "http://spam" })).toEqual({ status: 200, data: { ok: true } });
    expect(inbox.tenants.size).toBe(0);
  });

  it("le patron modifie sa propre fiche, et seulement elle", async () => {
    const { token, login: id } = (await signup(awa)).data;
    const fiche = (await call(`companies/${id}`, undefined, token)).data.tenant;
    const edit = await call("companies", {
      ...fiche,
      catalog: { products: [{ name: "Pagne wax 6 yards", price: "12 000", unit: "pièce" }] },
      subscription: { plan: "business", paidUntil: Date.now() + 999 * DAY },
    }, token);
    expect(edit.status).toBe(200);
    expect(edit.data.tenant.catalog.products[0]).toMatchObject({ name: "Pagne wax 6 yards" });
    // l'abonnement ne se modifie pas depuis la fiche
    expect(edit.data.tenant.subscription).toEqual(fiche.subscription);

    expect((await call("companies/sicar", undefined, token)).status).toBe(403);
    expect((await call("companies", { id: "sicar", businessName: "Pris" }, token)).status).toBe(403);
    for (const action of ["password", "delete", "whatsapp", "subscription"]) {
      expect((await call(`companies/${id}/${action}`, { password: "Nouveau-mot-2026", phoneNumberId: "12345678", paidMonths: 12 }, token)).status).toBe(403);
    }
    expect((await call(`companies/${id}/whatsapp/disconnect`, {}, token)).status).toBe(200);
  });

  it("l'administrateur prolonge l'essai ou enregistre un abonnement payé", async () => {
    const { login: id } = (await signup(awa)).data;
    const admin = await login("admin", "admin-secret");
    const start = inbox.tenants.get(id)!.tenant.subscription!;
    const longer = (await call(`companies/${id}/subscription`, { trialDays: 7 }, admin)).data.tenant.subscription;
    expect(longer.trialEndsAt - start.trialEndsAt!).toBe(7 * DAY);
    const paid = (await call(`companies/${id}/subscription`, { paidMonths: 1, plan: "business" }, admin)).data.tenant.subscription;
    expect(paid.plan).toBe("business");
    expect(paid.paidUntil - Date.now()).toBeGreaterThan(29 * DAY);
    // une entreprise créée par l'équipe n'a pas d'abonnement à gérer
    expect((await call("companies/sicar/subscription", { paidMonths: 1 }, admin)).status).toBe(400);
  });
});

describe("deux inscriptions au même nom en même temps", () => {
  it("la seconde prend l'identifiant suivant au lieu d'écraser la première", async () => {
    // Simule une inscription arrivée entre la lecture de la liste et l'enregistrement.
    const insert = inbox.insertTenant.bind(inbox);
    let first = true;
    inbox.insertTenant = async (tenant: Tenant) => {
      if (first) {
        first = false;
        await insert({ ...tenant, businessName: "Arrivée juste avant" });
        return false;
      }
      return insert(tenant);
    };
    const req = new Request("https://wakil.example/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://wakil.example" },
      body: JSON.stringify({ businessName: "Boutique Awa", phone: "0707070707", wakilPhone: "0708080808", numberFree: true, password: "Pagne-Wax-2026", accept: true }),
    });
    const data = (await (await handleApi(req, env, new URL(req.url))).json()) as any;
    expect(data.login).toBe("boutique-awa-2");
    expect(inbox.tenants.get("boutique-awa")!.tenant.businessName).toBe("Arrivée juste avant");
    expect(inbox.tenants.get("boutique-awa")!.secrets.passwordHash).toBeNull();
  });
});

describe("numéro WhatsApp hébergé par Wakil", () => {
  const signupBody = {
    businessName: "Ferme Koné",
    phone: "07 07 07 07 07",
    wakilPhone: "07 08 08 08 08",
    numberFree: true,
    countryCode: "225",
    password: "Poussin-Chair-2026",
    accept: true,
  };
  let graph: { url: string; method: string; body: any }[];
  let replies: Record<string, () => Response>;

  beforeEach(() => {
    env.WHATSAPP_WABA_ID = "999000";
    env.WHATSAPP_TOKEN = "PLATFORM";
    graph = [];
    replies = {};
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      graph.push({ url: url.pathname + url.search, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
      const key = Object.keys(replies).find((k) => url.pathname.endsWith(k));
      return key ? replies[key]() : Response.json({ success: true });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function signedUp() {
    const req = new Request("https://wakil.example/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://wakil.example" },
      body: JSON.stringify(signupBody),
    });
    const data = (await (await handleApi(req, env, new URL(req.url))).json()) as any;
    return { id: data.login as string, patron: data.token as string, admin: await login("admin", "admin-secret") };
  }
  const meta = (path: string) => graph.filter((g) => g.url.includes(path));

  it("l'équipe valide, le patron saisit le code, et Wakil répond sur le numéro", async () => {
    replies["/999000/phone_numbers"] = () => Response.json({ id: "55501" });
    replies["/55501"] = () => Response.json({ display_phone_number: "+225 07 08 08 08 08" });
    const { id, patron, admin } = await signedUp();

    // Le patron ne peut pas valider lui-même.
    expect((await call(`companies/${id}/whatsapp/hosted`, {}, patron)).status).toBe(403);

    const validated = await call(`companies/${id}/whatsapp/hosted`, { method: "SMS" }, admin);
    expect(validated.status).toBe(200);
    expect(validated.data.tenant.hostedNumber).toMatchObject({ state: "code_sent", phoneNumberId: "55501", codeMethod: "SMS" });
    expect(meta("/phone_numbers")[0]).toMatchObject({ method: "POST", body: { cc: "225", phone_number: "0708080808", verified_name: "Ferme Koné" } });
    expect(meta("/request_code")[0].url).toBe("/v23.0/55501/request_code?code_method=SMS&language=fr");

    expect((await call(`companies/${id}/whatsapp/verify`, { code: "12" }, patron)).data).toEqual({ error: "invalid", field: "code" });
    const live = await call(`companies/${id}/whatsapp/verify`, { code: "123-456" }, patron);
    expect(live.status).toBe(200);
    expect(meta("/verify_code")[0].url).toBe("/v23.0/55501/verify_code?code=123456");
    expect(meta("/register")[0].body).toEqual({ messaging_product: "whatsapp", pin: expect.stringMatching(/^\d{6}$/) });
    expect(live.data.tenant.whatsapp).toEqual({ phoneNumberId: "55501", wabaId: "999000", displayPhone: "+225 07 08 08 08 08" });
    expect(live.data.tenant.hostedNumber).toMatchObject({ state: "connected", connectedAt: expect.any(Number) });
    expect(inbox.tenants.get(id)!.secrets).toMatchObject({ whatsappToken: null, whatsappPin: expect.stringMatching(/^\d{6}$/) });
    expect((await call(`companies/${id}/whatsapp/verify`, { code: "123456" }, patron)).status).toBe(409);
  });

  it("garde la cause d'un refus de Meta, et reprend sans recréer le numéro", async () => {
    replies["/999000/phone_numbers"] = () => Response.json({ id: "55501" });
    replies["/request_code"] = () => Response.json({ error: { message: "Too many attempts", code: 136025 } }, { status: 400 });
    const { id, admin } = await signedUp();
    const refused = await call(`companies/${id}/whatsapp/hosted`, {}, admin);
    expect(refused).toMatchObject({ status: 502, data: { error: "meta_error", message: "Too many attempts" } });
    expect(inbox.tenants.get(id)!.tenant.hostedNumber).toMatchObject({ state: "submitted", phoneNumberId: "55501", error: "Too many attempts" });

    replies["/request_code"] = () => Response.json({ success: true });
    const retry = await call(`companies/${id}/whatsapp/hosted`, { method: "VOICE" }, admin);
    expect(retry.data.tenant.hostedNumber).toMatchObject({ state: "code_sent", codeMethod: "VOICE" });
    expect(retry.data.tenant.hostedNumber.error).toBeUndefined();
    expect(meta("/phone_numbers")).toHaveLength(1);
  });

  it("un mauvais code est signalé au patron, qui peut réessayer", async () => {
    replies["/999000/phone_numbers"] = () => Response.json({ id: "55501" });
    replies["/verify_code"] = () => Response.json({ error: { message: "Code de vérification incorrect", code: 136023 } }, { status: 400 });
    const { id, patron, admin } = await signedUp();
    await call(`companies/${id}/whatsapp/hosted`, {}, admin);
    const wrong = await call(`companies/${id}/whatsapp/verify`, { code: "000000" }, patron);
    expect(wrong).toMatchObject({ status: 400, data: { error: "wrong_code", message: "Code de vérification incorrect" } });
    expect(inbox.tenants.get(id)!.tenant.hostedNumber).toMatchObject({ state: "code_sent", error: "Code de vérification incorrect" });
    expect(inbox.tenants.get(id)!.tenant.whatsapp).toBeUndefined();
  });

  it("un numéro déjà vérifié est activé tout de suite, sans code", async () => {
    replies["/999000/phone_numbers"] = () => Response.json({ id: "55501" });
    replies["/request_code"] = () => Response.json({ error: { message: "Already verified", code: 136024 } }, { status: 400 });
    const { id, admin } = await signedUp();
    const live = await call(`companies/${id}/whatsapp/hosted`, {}, admin);
    expect(live.data.tenant.hostedNumber.state).toBe("connected");
    expect(live.data.tenant.whatsapp.phoneNumberId).toBe("55501");
  });

  it("demande le compte WhatsApp de Wakil, et la fiche modifiée garde la demande", async () => {
    const { id, patron, admin } = await signedUp();
    delete env.WHATSAPP_WABA_ID;
    expect((await call(`companies/${id}/whatsapp/hosted`, {}, admin)).data).toEqual({ error: "waba_not_configured" });
    const fiche = (await call(`companies/${id}`, undefined, patron)).data.tenant;
    const edited = await call("companies", { ...fiche, assistantName: "Awa" }, patron);
    expect(edited.data.tenant.hostedNumber).toMatchObject({ phone: "2250708080808", state: "submitted" });
    expect((await call("companies/sicar/whatsapp/hosted", {}, admin)).data).toEqual({ error: "no_request" });
  });
});
