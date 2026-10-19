import type { ConversationDO } from "./conversation-do";

/** Bindings et variables du Worker (voir wrangler.jsonc et .dev.vars.example). */
export interface Env {
  CONVERSATIONS: DurableObjectNamespace<ConversationDO>;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  WHATSAPP_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_VERIFY_TOKEN: string;
  GRAPH_API_VERSION?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  DEBOUNCE_MS?: string;
}

/** Une entreprise cliente de Wakil, rattachée à un numéro WhatsApp (phone_number_id). */
export interface Tenant {
  id: string;
  businessName: string;
  assistantName: string;
  /** Numéro WhatsApp du patron, format international sans "+" (ex. 2250700000000). */
  ownerPhone: string;
  /**
   * Modèle de message approuvé par Meta pour prévenir le patron hors de la fenêtre de 24 h.
   * Le modèle doit avoir une seule variable {{1}} dans le corps.
   */
  ownerNotifyTemplate?: { name: string; language: string };
  timezone: string;
  catalog: {
    productsUrl: string;
    siteUrl?: string;
    /** Base des URL d'images relatives du catalogue (avec "/" final). */
    assetBaseUrl: string;
  };
  paymentInstructions?: string;
  /** Connaissances métier propres à l'entreprise, ajoutées au prompt. */
  instructions?: string;
  handoffHours?: number;
}

export type IncomingKind = "text" | "audio" | "image" | "location" | "unsupported";

/** Message WhatsApp entrant, normalisé. */
export interface IncomingMessage {
  id: string;
  from: string;
  name?: string;
  timestamp: number;
  kind: IncomingKind;
  text?: string;
  mediaId?: string;
  mimeType?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  rawType: string;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  granulometrie?: string;
  description?: string;
  usages: string[];
  price: string;
  unit: string;
  imageUrl?: string;
  available: boolean;
}

export interface BusinessInfo {
  phone?: string;
  email?: string;
  address?: string;
  hours?: string;
  about?: string;
  faq: { q: string; a: string }[];
}

export interface Catalog {
  products: Product[];
  info: BusinessInfo;
}

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
}

export interface Order {
  reference: string;
  createdAt: number;
  customerPhone: string;
  customerName: string;
  items: OrderItem[];
  fulfilment: "livraison" | "enlevement";
  deliveryLocation?: string;
  desiredDate?: string;
  notes?: string;
}
