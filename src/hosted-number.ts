type FetchLike = typeof fetch;

export interface MetaContext {
  apiVersion: string;
  /** Jeton de la plateforme (utilisateur système), qui gère le compte WhatsApp de Wakil. */
  token: string;
  fetchFn?: FetchLike;
}

/** Refus de Meta, avec son code et, s'il a déjà été créé, l'identifiant du numéro. */
export class MetaError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    public phoneNumberId?: string,
  ) {
    super(message);
  }
}

/** Code de Meta : le numéro est déjà vérifié, il n'y a plus de code à envoyer. */
export const ALREADY_VERIFIED = 136024;

function graph(ctx: MetaContext) {
  const base = `https://graph.facebook.com/${ctx.apiVersion}`;
  const fetchFn = ctx.fetchFn ?? ((input, init) => fetch(input, init));
  return async (path: string, init: { method?: string; query?: Record<string, string>; body?: unknown } = {}) => {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await fetchFn(url.toString(), {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${ctx.token.trim()}`, "content-type": "application/json" },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new MetaError(data.error?.error_user_msg || data.error?.message || `Erreur Meta ${res.status}`, data.error?.code);
    return data;
  };
}

/**
 * Validation par l'équipe : ajoute le numéro au compte WhatsApp de Wakil (s'il n'y est pas déjà),
 * puis demande à Meta d'envoyer le code au client, par SMS ou par appel.
 */
export async function requestHostedCode(
  ctx: MetaContext & { wabaId: string },
  number: { phone: string; countryCode: string; displayName: string; phoneNumberId?: string; method: "SMS" | "VOICE" },
): Promise<{ phoneNumberId: string; alreadyVerified: boolean }> {
  const call = graph(ctx);
  let phoneNumberId = number.phoneNumberId;
  if (!phoneNumberId) {
    const national = number.phone.startsWith(number.countryCode) ? number.phone.slice(number.countryCode.length) : number.phone;
    const created = await call(`${ctx.wabaId}/phone_numbers`, {
      method: "POST",
      body: { cc: number.countryCode, phone_number: national, verified_name: number.displayName },
    });
    phoneNumberId = String(created.id ?? "");
    if (!/^\d+$/.test(phoneNumberId)) throw new MetaError("Meta n'a pas renvoyé d'identifiant pour ce numéro");
  }
  const id = phoneNumberId;
  const send = (language: string) => call(`${id}/request_code`, { method: "POST", query: { code_method: number.method, language } });
  try {
    try {
      await send("fr");
    } catch (err) {
      // Le code en français n'est peut-être pas proposé partout : on le demande en anglais.
      if (err instanceof MetaError && err.code !== ALREADY_VERIFIED && /language/i.test(err.message)) await send("en_US");
      else throw err;
    }
  } catch (err) {
    if (err instanceof MetaError && err.code === ALREADY_VERIFIED) return { phoneNumberId: id, alreadyVerified: true };
    if (err instanceof MetaError) err.phoneNumberId = id;
    throw err;
  }
  return { phoneNumberId: id, alreadyVerified: false };
}

/** Le client a reçu le code : Meta le vérifie. */
export async function verifyHostedCode(ctx: MetaContext, phoneNumberId: string, code: string): Promise<void> {
  await graph(ctx)(`${phoneNumberId}/verify_code`, { method: "POST", query: { code } });
}

/** Active le numéro vérifié sur l'API Cloud avec un code PIN tiré au hasard. */
export async function registerHostedNumber(ctx: MetaContext, phoneNumberId: string): Promise<{ pin: string; displayPhone?: string }> {
  const call = graph(ctx);
  const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await call(`${phoneNumberId}/register`, { method: "POST", body: { messaging_product: "whatsapp", pin } });
  const info = await call(phoneNumberId, { query: { fields: "display_phone_number" } }).catch(() => ({}));
  return { pin, displayPhone: (info as { display_phone_number?: string }).display_phone_number };
}
