import { bytesToHex, timingSafeEqual } from "./encoding";

/** Durée d'une connexion à l'application. */
export const SESSION_MS = 30 * 24 * 3_600_000;

/** Qui est connecté : l'administrateur de Wakil, ou le patron d'une entreprise. */
export type Role = { kind: "admin" } | { kind: "tenant"; tenantId: string };

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

const roleLabel = (role: Role) => (role.kind === "admin" ? "admin" : `t-${role.tenantId}`);

/**
 * Jeton de session signé avec le secret de l'application (ADMIN_PASSWORD) : changer ce
 * mot de passe déconnecte tous les appareils.
 */
export async function createToken(secret: string, role: Role, now: number): Promise<string> {
  const payload = `${roleLabel(role)}.${now + SESSION_MS}`;
  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifyToken(secret: string, token: string, now: number): Promise<Role | null> {
  const [label, expires, mac] = token.split(".");
  if (!label || !expires || !mac || !/^\d+$/.test(expires) || Number(expires) < now) return null;
  if (!timingSafeEqual(mac, await sign(secret, `${label}.${expires}`))) return null;
  if (label === "admin") return { kind: "admin" };
  return label.startsWith("t-") && label.length > 2 ? { kind: "tenant", tenantId: label.slice(2) } : null;
}

/** Compare deux mots de passe sans révéler, par le temps de réponse, où ils diffèrent. */
export async function samePassword(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sign("compare", a), sign("compare", b)]);
  return timingSafeEqual(ha, hb);
}

/** Plafond des itérations PBKDF2 accepté par le moteur des Workers. */
const ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

/** Empreinte d'un mot de passe de patron : « pbkdf2$itérations$sel$empreinte ». */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${bytesToHex(salt)}$${await pbkdf2(password, salt, ITERATIONS)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, saltHex, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !saltHex || !hash) return false;
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return timingSafeEqual(await pbkdf2(password, salt, Number(iterations)), hash);
}
