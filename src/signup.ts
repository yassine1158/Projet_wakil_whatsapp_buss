import { createToken, hashPassword } from "./auth";
import { slugify } from "./catalog";
import { parseTenantInput, TENANT_ID_RE } from "./companies";
import { normalizePhone } from "./engine";
import { notifyWakilTeam } from "./leads";
import { INBOX_NAME } from "./names";
import { invalidateTenants, listTenants } from "./registry";
import { startTrial, TRIAL_DAYS } from "./subscription";
import type { Env, Tenant } from "./types";

/** Indicatifs proposés à l'inscription, avec le fuseau horaire qui va avec. */
export const SIGNUP_COUNTRIES: Record<string, string> = {
  "225": "Africa/Abidjan",
  "221": "Africa/Dakar",
  "223": "Africa/Bamako",
  "226": "Africa/Ouagadougou",
  "224": "Africa/Conakry",
  "228": "Africa/Lome",
  "229": "Africa/Porto-Novo",
  "237": "Africa/Douala",
  "216": "Africa/Tunis",
  "212": "Africa/Casablanca",
  "33": "Europe/Paris",
};

/** Identifiants qu'une inscription ne peut pas prendre. */
const RESERVED = new Set(["admin", "new", "wakil", "demo", "test", "api", "app"]);

export interface SignupForm {
  businessName: string;
  phone: string;
  password: string;
  countryCode: string;
  sector: string;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function parseSignup(body: Record<string, unknown>): SignupForm | { error: string; field?: string } {
  const businessName = text(body.businessName, 80);
  if (businessName.length < 2) return { error: "required", field: "businessName" };
  const countryCode = typeof body.countryCode === "string" && body.countryCode in SIGNUP_COUNTRIES ? body.countryCode : "225";
  const phone = normalizePhone(text(body.phone, 30), countryCode);
  if (!phone) return { error: "invalid_phone", field: "phone" };
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8 || password.length > 200) return { error: "weak_password", field: "password" };
  if (body.accept !== true) return { error: "required", field: "accept" };
  return { businessName, phone, password, countryCode, sector: text(body.sector, 60) };
}

/** Identifiant de connexion tiré du nom, rendu unique. */
export function uniqueTenantId(businessName: string, taken: Set<string>): string {
  let base = slugify(businessName).slice(0, 34).replace(/-+$/, "");
  if (!TENANT_ID_RE.test(base) || RESERVED.has(base)) base = "entreprise";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * POST /api/signup, depuis la page /inscription : l'entreprise est créée avec un essai
 * gratuit et un catalogue vide, et le patron est connecté tout de suite.
 */
export async function handleSignup(
  request: Request,
  env: Env,
  url: URL,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  if (request.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
  // Champ invisible pour les humains : un robot qui le remplit ne reçoit pas de compte.
  if (typeof body.website === "string" && body.website) return json({ ok: true });
  if (env.CHAT_LIMITER) {
    const { success } = await env.CHAT_LIMITER.limit({ key: `signup:${request.headers.get("cf-connecting-ip") ?? "inconnu"}` });
    if (!success) return json({ error: "rate_limited" }, 429);
  }

  const form = parseSignup(body);
  if ("error" in form) return json(form, 400);
  const tenants = await listTenants(env, now);
  // Un essai par numéro : le même patron ne recommence pas un essai avec un autre nom.
  if (tenants.some((t) => t.ownerPhone === form.phone)) return json({ error: "phone_in_use", field: "phone" }, 409);

  const inbox = env.INBOX.get(env.INBOX.idFromName(INBOX_NAME));
  const taken = new Set(tenants.map((t) => t.id));
  let tenant: Tenant | undefined;
  // L'insertion échoue si une autre inscription vient de prendre le même identifiant : on prend le suivant.
  for (let attempt = 0; attempt < 5 && !tenant; attempt++) {
    const parsed = parseTenantInput({
      id: uniqueTenantId(form.businessName, taken),
      businessName: form.businessName,
      ownerPhone: form.phone,
      timezone: SIGNUP_COUNTRIES[form.countryCode],
      defaultCountryCode: form.countryCode,
      catalog: { products: [] },
      handoffHours: 12,
    });
    if ("error" in parsed) return json(parsed, 400);
    const candidate: Tenant = { ...parsed, subscription: startTrial("pro", now) };
    if (await inbox.insertTenant(candidate, now)) tenant = candidate;
    else taken.add(candidate.id);
  }
  if (!tenant) return json({ error: "server_error" }, 500);
  const id = tenant.id;
  await inbox.setTenantPassword(id, await hashPassword(form.password));
  invalidateTenants();
  const note = `Inscription en ligne · essai de ${TRIAL_DAYS} jours · identifiant « ${id} »`;
  await inbox.addLead({ createdAt: now, name: "", company: form.businessName, sector: form.sector, city: "", phone: form.phone, message: note });
  await notifyWakilTeam(env, `🎉 Nouvelle inscription : ${form.businessName}\n${note}\nTéléphone : +${form.phone}\nRépondre : https://wa.me/${form.phone}`);

  return json({ token: await createToken(env.ADMIN_PASSWORD!, { kind: "tenant", tenantId: id }, now), login: id });
}
