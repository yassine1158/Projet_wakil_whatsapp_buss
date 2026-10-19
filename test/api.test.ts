import { beforeEach, describe, expect, it } from "vitest";
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
