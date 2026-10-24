import type { Lead } from "./leads";
import type { Channel, Order, Tenant } from "./types";

/** Types et constantes de la boîte de réception, sans dépendre du moteur des Workers. */
export type ConversationStatus = "wakil" | "equipe";
export type OrderStatus = "nouvelle" | "confirmee" | "livree" | "annulee";
export type LeadStatus = "nouvelle" | "contactee";

export const ORDER_STATUSES: OrderStatus[] = ["nouvelle", "confirmee", "livree", "annulee"];
export const LEAD_STATUSES: LeadStatus[] = ["nouvelle", "contactee"];

export interface ConversationRow {
  key: string;
  tenant: string;
  channel: Channel;
  customerId: string;
  name: string | null;
  phone: string | null;
  lastText: string;
  lastFrom: "client" | "wakil" | "equipe";
  lastAt: number;
  status: ConversationStatus;
  test: boolean;
}

export interface OrderRow extends Order {
  tenant: string;
  conversationKey: string;
  status: OrderStatus;
}

export interface LeadRow extends Lead {
  id: number;
  status: LeadStatus;
}

/** Secrets d'une entreprise : jamais renvoyés tels quels à l'application. */
export interface TenantSecrets {
  passwordHash: string | null;
  whatsappToken: string | null;
  whatsappPin: string | null;
}

export interface StoredTenant {
  tenant: Tenant;
  hasPassword: boolean;
  hasWhatsappToken: boolean;
  updatedAt: number;
}

export interface Overview {
  newOrders: number;
  waitingForTeam: number;
  conversationsToday: number;
  ordersThisWeek: number;
  newLeads: number;
}

/** Un message vu par Wakil Brain en mode ombre. */
export interface BrainSampleRow {
  id: number;
  tenant: string;
  at: number;
  context: string;
  text: string;
  predicted: string;
  confidence: number;
  teacher: string;
}

/** Accord entre Wakil Brain et Claude. */
export interface BrainStats {
  total: number;
  agreed: number;
  /** Par action de Claude : combien de fois, et combien de fois Wakil Brain a dit pareil. */
  byTeacher: Record<string, { total: number; agreed: number }>;
  recent: BrainSampleRow[];
}
