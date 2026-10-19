import type { ConversationDO } from "./conversation-do";
import type { InboxDO } from "./inbox-do";

/** Bindings et variables du Worker (voir wrangler.jsonc et .dev.vars.example). */
export interface Env {
  CONVERSATIONS: DurableObjectNamespace<ConversationDO>;
  INBOX: DurableObjectNamespace<InboxDO>;
  /** Mot de passe de l'administrateur de l'application (/app) ; signe aussi les sessions. */
  ADMIN_PASSWORD?: string;
  /** Inscription intégrée de Meta (« Connecter WhatsApp ») : identifiants publics de l'application Meta. */
  META_APP_ID?: string;
  META_CONFIG_ID?: string;
  AI: Ai;
  /** Limite le nombre de messages du chat web par adresse IP (facultatif). */
  CHAT_LIMITER?: RateLimit;
  ANTHROPIC_API_KEY: string;
  /** Facultatif : passer les appels au modèle par Cloudflare AI Gateway (suivi des coûts). */
  ANTHROPIC_BASE_URL?: string;
  WHATSAPP_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_VERIFY_TOKEN: string;
  GRAPH_API_VERSION?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  DEBOUNCE_MS?: string;
}

/** Une entreprise cliente de Wakil. Elle peut avoir un numéro WhatsApp, un chat sur son site, ou les deux. */
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
  /** Indicatif ajouté aux numéros locaux donnés sur le chat web (ex. "225"). */
  defaultCountryCode?: string;
  /** Sites autorisés à afficher le chat web (ex. "https://yassine1158.github.io"). */
  webOrigins?: string[];
  /** Entreprise fictive de démonstration, affichée sur le site de Wakil lui-même. */
  demo?: boolean;
  /** Numéro WhatsApp de l'entreprise, relié à l'API WhatsApp Cloud. */
  whatsapp?: { phoneNumberId: string; displayPhone?: string; wabaId?: string };
  /**
   * Catalogue : soit une adresse (products.json et site.json d'un site, format SICAR),
   * soit des produits saisis dans l'application.
   */
  catalog: {
    productsUrl?: string;
    siteUrl?: string;
    /** Base des URL d'images relatives du catalogue (avec "/" final). */
    assetBaseUrl?: string;
    products?: RawProduct[];
  };
  /** Informations données aux clients (saisies dans l'application). */
  info?: { phone?: string; email?: string; address?: string; hours?: string; about?: string };
  paymentInstructions?: string;
  /** Connaissances métier propres à l'entreprise, ajoutées au prompt. */
  instructions?: string;
  handoffHours?: number;
}

/** Produit tel qu'il est saisi ou importé (Excel, CSV, products.json). */
export interface RawProduct {
  id?: string;
  name: string;
  category?: string;
  granulometrie?: string;
  description?: string;
  usages?: string[];
  price?: string;
  unit?: string;
  image?: string;
  available?: boolean;
}

export type Channel = "whatsapp" | "web";

/** Ce que l'on sait d'une conversation, gardé dans son Durable Object. */
export interface ConversationMeta {
  channel: Channel;
  tenantId: string;
  /** Numéro WhatsApp de l'entreprise (vide pour une entreprise sans WhatsApp). */
  phoneNumberId: string;
  /** Numéro WhatsApp du client, ou identifiant de session du chat web. */
  customerId: string;
  /** Connu d'office sur WhatsApp ; demandé au client sur le chat web. */
  customerPhone?: string;
  customerName?: string;
  /** Conversation d'essai lancée depuis l'application : personne n'est prévenu. */
  test?: boolean;
}

/** Une ligne du fil de conversation affiché dans l'application. */
export interface LogEntry {
  from: "client" | "wakil" | "equipe";
  text: string;
  at: number;
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
  channel: Channel;
  customerPhone: string;
  customerName: string;
  items: OrderItem[];
  fulfilment: "livraison" | "enlevement";
  deliveryLocation?: string;
  desiredDate?: string;
  notes?: string;
}
