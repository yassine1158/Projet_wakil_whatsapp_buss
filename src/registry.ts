import configTenants from "../config/tenants.json";
import wakil from "../config/wakil.json";
import type { WhatsAppSender } from "./engine";
import { INBOX_NAME } from "./names";
import type { Env, Tenant } from "./types";
import { WhatsAppClient } from "./whatsapp";

/**
 * Registre des entreprises : celles de config/tenants.json, plus celles créées ou
 * modifiées dans l'application (qui l'emportent à identifiant égal).
 */
const CONFIG = configTenants as unknown as Tenant[];

/** Durée pendant laquelle une copie du registre est réutilisée dans une même instance. */
const CACHE_MS = 30_000;
let cache: { at: number; tenants: Tenant[] } | null = null;

const inbox = (env: Env) => env.INBOX.get(env.INBOX.idFromName(INBOX_NAME));

export function configTenantIds(): Set<string> {
  return new Set(CONFIG.map((t) => t.id));
}

/** À appeler après une modification, pour que cette instance la voie tout de suite. */
export function invalidateTenants() {
  cache = null;
}

export async function listTenants(env: Env, now = Date.now()): Promise<Tenant[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.tenants;
  const byId = new Map(CONFIG.map((t) => [t.id, t]));
  try {
    for (const stored of await inbox(env).listTenants()) byId.set(stored.tenant.id, stored.tenant);
  } catch (err) {
    // Sans la base, les entreprises du fichier de configuration continuent de fonctionner.
    console.error("Lecture des entreprises échouée", err);
  }
  cache = { at: now, tenants: [...byId.values()] };
  return cache.tenants;
}

export async function tenantById(env: Env, id: string): Promise<Tenant | undefined> {
  return (await listTenants(env)).find((t) => t.id === id);
}

/** Retrouve l'entreprise à partir du numéro WhatsApp qui a reçu le message. */
export async function tenantByPhoneNumberId(env: Env, phoneNumberId: string): Promise<Tenant | undefined> {
  return (await listTenants(env)).find((t) => t.whatsapp?.phoneNumberId === phoneNumberId);
}

/** Vrai si au moins une entreprise autorise ce site à afficher le chat. */
export async function isKnownWebOrigin(env: Env, origin: string): Promise<boolean> {
  return (await listTenants(env)).some((t) => t.webOrigins?.includes(origin));
}

const isPlaceholder = (v: string) => !v || /^REMPLACER/.test(v);

/** Expéditeur qui refuse tout : l'entreprise n'a pas de numéro et la plateforme non plus. */
const NO_WHATSAPP: WhatsAppSender = {
  sendText: async () => { throw new Error("Aucun numéro WhatsApp configuré"); },
  sendImage: async () => { throw new Error("Aucun numéro WhatsApp configuré"); },
  sendTemplate: async () => { throw new Error("Aucun numéro WhatsApp configuré"); },
  markReadWithTyping: async () => {},
  downloadMedia: async () => { throw new Error("Aucun numéro WhatsApp configuré"); },
};

/**
 * Numéro qui parle au nom de l'entreprise : le sien s'il en a un (avec son propre jeton
 * s'il a été relié par « Connecter WhatsApp »), sinon celui de la plateforme, qui sert
 * alors seulement à prévenir le patron.
 */
export async function whatsappFor(env: Env, tenant: Tenant): Promise<WhatsAppSender> {
  const own = tenant.whatsapp?.phoneNumberId;
  if (own) {
    let token = env.WHATSAPP_TOKEN;
    try {
      token = (await inbox(env).tenantSecrets(tenant.id))?.whatsappToken ?? token;
    } catch (err) {
      console.error("Lecture du jeton WhatsApp échouée", err);
    }
    return new WhatsAppClient(token, own, env.GRAPH_API_VERSION);
  }
  const platform = wakil.leads.senderPhoneNumberId;
  return isPlaceholder(platform) ? NO_WHATSAPP : new WhatsAppClient(env.WHATSAPP_TOKEN, platform, env.GRAPH_API_VERSION);
}
