import { bytesToHex, timingSafeEqual } from "./encoding";

/** Durée d'une connexion à l'application. */
export const SESSION_MS = 30 * 24 * 3_600_000;

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`wakil-app:${payload}`));
  return bytesToHex(new Uint8Array(mac));
}

/**
 * Jeton de session signé avec le mot de passe : changer le mot de passe
 * déconnecte tous les appareils.
 */
export async function createToken(password: string, now: number): Promise<string> {
  const expires = String(now + SESSION_MS);
  return `${expires}.${await sign(password, expires)}`;
}

export async function verifyToken(password: string, token: string, now: number): Promise<boolean> {
  const [expires, mac] = token.split(".");
  if (!expires || !mac || !/^\d+$/.test(expires) || Number(expires) < now) return false;
  return timingSafeEqual(mac, await sign(password, expires));
}

/** Compare deux mots de passe sans révéler, par le temps de réponse, où ils diffèrent. */
export async function samePassword(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sign("compare", a), sign("compare", b)]);
  return timingSafeEqual(ha, hb);
}
