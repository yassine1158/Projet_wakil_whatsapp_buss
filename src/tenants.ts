import tenants from "../config/tenants.json";
import type { Tenant } from "./types";

const TENANTS = tenants as unknown as Record<string, Tenant>;

/** Retrouve l'entreprise à partir du phone_number_id du numéro WhatsApp qui a reçu le message. */
export function getTenant(phoneNumberId: string): Tenant | undefined {
  return Object.hasOwn(TENANTS, phoneNumberId) ? TENANTS[phoneNumberId] : undefined;
}
