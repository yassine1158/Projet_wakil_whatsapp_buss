import { slugify } from "./catalog";
import { normalizePhone } from "./engine";
import { VOICE_REPLIES, type RawProduct, type Tenant } from "./types";

export const TENANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MAX_PRODUCTS = 500;

export type FieldError = { error: string; field: string };

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length <= max ? s : null;
};

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function httpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** Adresse d'un site autorisé à afficher le chat : « https://exemple.com », sans chemin. */
function origin(v: string): string | null {
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

function parseProducts(raw: unknown): RawProduct[] | FieldError {
  if (!Array.isArray(raw)) return { error: "invalid", field: "products" };
  if (raw.length > MAX_PRODUCTS) return { error: "too_many_products", field: "products" };
  const out: RawProduct[] = [];
  for (const [i, p] of raw.entries()) {
    const name = text(p?.name, 120);
    if (!name) {
      if (!p?.name) continue; // ligne vide du tableau
      return { error: "too_long", field: `products.${i}.name` };
    }
    const fields = {
      category: text(p.category, 60),
      description: text(p.description, 500),
      price: text(p.price, 40),
      unit: text(p.unit, 30),
      image: text(p.image, 500),
    };
    for (const [k, v] of Object.entries(fields)) if (v === null) return { error: "too_long", field: `products.${i}.${k}` };
    if (fields.image && !httpsUrl(fields.image)) return { error: "invalid_url", field: `products.${i}.image` };
    out.push({
      id: typeof p.id === "string" && /^[a-z0-9-]{1,60}$/.test(p.id) ? p.id : slugify(name),
      name,
      ...(fields.category ? { category: fields.category } : {}),
      ...(fields.description ? { description: fields.description } : {}),
      price: fields.price ?? "",
      unit: fields.unit || "unité",
      ...(fields.image ? { image: fields.image } : {}),
      available: p.available !== false,
    });
  }
  return out;
}

/**
 * Valide la fiche d'une entreprise envoyée par l'application. Le numéro WhatsApp n'est
 * pas modifiable ici : il se relie par sa propre route.
 */
export function parseTenantInput(body: Record<string, unknown>, existing?: Tenant): Tenant | FieldError {
  const id = existing?.id ?? (typeof body.id === "string" ? body.id.trim().toLowerCase() : "");
  if (!TENANT_ID_RE.test(id)) return { error: "invalid", field: "id" };

  const businessName = text(body.businessName, 80);
  if (!businessName) return { error: businessName === null ? "too_long" : "required", field: "businessName" };
  const assistantName = text(body.assistantName, 40) || "Wakil";

  const timezone = text(body.timezone, 60) || "Africa/Abidjan";
  if (!validTimezone(timezone)) return { error: "invalid", field: "timezone" };
  const countryCode = text(body.defaultCountryCode, 4) ?? "";
  if (countryCode && !/^\d{1,4}$/.test(countryCode)) return { error: "invalid", field: "defaultCountryCode" };

  const rawOwner = text(body.ownerPhone, 30) ?? "";
  const ownerPhone = rawOwner ? normalizePhone(rawOwner, countryCode || undefined) : "";
  if (rawOwner && !ownerPhone) return { error: "invalid_phone", field: "ownerPhone" };

  const webOrigins: string[] = [];
  for (const o of Array.isArray(body.webOrigins) ? body.webOrigins : []) {
    if (typeof o !== "string" || !o.trim()) continue;
    const parsed = origin(o.trim());
    if (!parsed) return { error: "invalid_url", field: "webOrigins" };
    if (!webOrigins.includes(parsed)) webOrigins.push(parsed);
  }

  const infoIn = (body.info ?? {}) as Record<string, unknown>;
  const info: NonNullable<Tenant["info"]> = {};
  for (const [k, max] of [["phone", 40], ["email", 120], ["address", 200], ["hours", 200], ["about", 1000]] as const) {
    const v = text(infoIn[k], max);
    if (v === null) return { error: "too_long", field: `info.${k}` };
    if (v) info[k] = v;
  }

  const catalogIn = (body.catalog ?? {}) as Record<string, unknown>;
  let catalog: Tenant["catalog"];
  if (Array.isArray(catalogIn.products)) {
    const products = parseProducts(catalogIn.products);
    if ("error" in products) return products;
    catalog = { products };
  } else {
    const productsUrl = text(catalogIn.productsUrl, 500) ?? "";
    if (!httpsUrl(productsUrl)) return { error: "invalid_url", field: "catalog.productsUrl" };
    const siteUrl = text(catalogIn.siteUrl, 500) ?? "";
    if (siteUrl && !httpsUrl(siteUrl)) return { error: "invalid_url", field: "catalog.siteUrl" };
    const assetBaseUrl = text(catalogIn.assetBaseUrl, 500) || new URL("./", productsUrl).toString().replace(/data\/$/, "");
    catalog = { productsUrl, ...(siteUrl ? { siteUrl } : {}), assetBaseUrl };
  }

  const instructions = text(body.instructions, 4000);
  if (instructions === null) return { error: "too_long", field: "instructions" };
  const paymentInstructions = text(body.paymentInstructions, 1000);
  if (paymentInstructions === null) return { error: "too_long", field: "paymentInstructions" };
  const handoffHours = Math.min(72, Math.max(1, Math.round(Number(body.handoffHours) || 12)));
  const voiceReplies = VOICE_REPLIES.find((v) => v === body.voiceReplies);

  return {
    id,
    businessName,
    assistantName,
    ownerPhone: ownerPhone ?? "",
    ...(existing?.ownerNotifyTemplate ? { ownerNotifyTemplate: existing.ownerNotifyTemplate } : {}),
    timezone,
    ...(countryCode ? { defaultCountryCode: countryCode } : {}),
    webOrigins,
    ...(existing?.demo ? { demo: true } : {}),
    ...(existing?.whatsapp ? { whatsapp: existing.whatsapp } : {}),
    catalog,
    ...(Object.keys(info).length ? { info } : {}),
    ...(paymentInstructions ? { paymentInstructions } : {}),
    ...(instructions ? { instructions } : {}),
    handoffHours,
    ...(voiceReplies && voiceReplies !== "after-voice" ? { voiceReplies } : {}),
  };
}

type FetchLike = typeof fetch;

export interface SignupResult {
  token: string;
  pin: string;
  displayPhone?: string;
}

/**
 * Fin de l'inscription intégrée de Meta (« Connecter WhatsApp ») : échange le code contre
 * un jeton de l'entreprise, abonne l'application à son compte WhatsApp et active le numéro
 * sur l'API Cloud avec un code PIN tiré au hasard.
 */
export async function completeWhatsappSignup(
  params: { appId: string; appSecret: string; apiVersion: string; code: string; phoneNumberId: string; wabaId: string },
  fetchFn: FetchLike = (input, init) => fetch(input, init),
): Promise<SignupResult> {
  const base = `https://graph.facebook.com/${params.apiVersion}`;
  const call = async (url: string, init?: RequestInit) => {
    const res = await fetchFn(url, init);
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(data.error?.message ?? `Erreur Meta ${res.status}`);
    return data;
  };
  const exchange = new URL(`${base}/oauth/access_token`);
  exchange.search = new URLSearchParams({ client_id: params.appId, client_secret: params.appSecret, code: params.code }).toString();
  const { access_token: token } = await call(exchange.toString());
  if (!token) throw new Error("Meta n'a pas renvoyé de jeton");

  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await call(`${base}/${params.wabaId}/subscribed_apps`, { method: "POST", headers: auth });
  const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await call(`${base}/${params.phoneNumberId}/register`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
  const info = await call(`${base}/${params.phoneNumberId}?fields=display_phone_number`, { headers: auth }).catch(() => ({}));
  return { token, pin, displayPhone: (info as { display_phone_number?: string }).display_phone_number };
}
