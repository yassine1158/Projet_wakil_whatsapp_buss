import tenants from "../config/tenants.json";
import type { Tenant } from "./types";

const TENANTS = tenants as unknown as Record<string, Tenant>;

/** Retrouve l'entreprise à partir du phone_number_id du numéro WhatsApp qui a reçu le message. */
export function getTenant(phoneNumberId: string): Tenant | undefined {
  return Object.hasOwn(TENANTS, phoneNumberId) ? TENANTS[phoneNumberId] : undefined;
}

/** Retrouve une entreprise par son identifiant (utilisé par le chat du site web). */
export function findTenantById(id: string): { phoneNumberId: string; tenant: Tenant } | undefined {
  for (const [phoneNumberId, tenant] of Object.entries(TENANTS)) {
    if (tenant.id === id) return { phoneNumberId, tenant };
  }
  return undefined;
}

/** Vrai si au moins une entreprise autorise ce site à afficher le chat. */
export function isKnownWebOrigin(origin: string): boolean {
  return Object.values(TENANTS).some((t) => t.webOrigins?.includes(origin));
}
