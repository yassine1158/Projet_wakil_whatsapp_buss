import { DurableObject } from "cloudflare:workers";
import type { Lead } from "./leads";
import type { Channel, Env, Order } from "./types";

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

export interface Overview {
  newOrders: number;
  waitingForTeam: number;
  conversationsToday: number;
  ordersThisWeek: number;
  newLeads: number;
}

/**
 * Boîte de réception de Wakil (une seule instance, "inbox") : le résumé de chaque
 * conversation, les commandes et les demandes du site. C'est ce que lit l'application.
 */
export class InboxDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        key TEXT PRIMARY KEY, tenant TEXT NOT NULL, channel TEXT NOT NULL, customer_id TEXT NOT NULL,
        name TEXT, phone TEXT, last_text TEXT NOT NULL, last_from TEXT NOT NULL, last_at INTEGER NOT NULL,
        status TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS conversations_by_tenant ON conversations (tenant, last_at);
      CREATE TABLE IF NOT EXISTS orders (
        ref TEXT PRIMARY KEY, tenant TEXT NOT NULL, conversation_key TEXT NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_by_tenant ON orders (tenant, created_at);
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
    `);
  }

  async touchConversation(row: ConversationRow): Promise<void> {
    this.sql.exec(
      `INSERT INTO conversations (key, tenant, channel, customer_id, name, phone, last_text, last_from, last_at, status, test)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET name = excluded.name, phone = excluded.phone, last_text = excluded.last_text,
         last_from = excluded.last_from, last_at = excluded.last_at, status = excluded.status`,
      row.key, row.tenant, row.channel, row.customerId, row.name, row.phone,
      row.lastText.slice(0, 300), row.lastFrom, row.lastAt, row.status, row.test ? 1 : 0,
    );
  }

  async setConversationStatus(key: string, status: ConversationStatus): Promise<void> {
    this.sql.exec("UPDATE conversations SET status = ? WHERE key = ?", status, key);
  }

  async listConversations(tenant: string, search = "", limit = 100): Promise<ConversationRow[]> {
    const like = `%${search.replace(/[%_]/g, "")}%`;
    return this.sql
      .exec(
        `SELECT * FROM conversations WHERE tenant = ? AND (? = '' OR name LIKE ? OR phone LIKE ? OR last_text LIKE ?)
         ORDER BY last_at DESC LIMIT ?`,
        tenant, search, like, like, like, limit,
      )
      .toArray()
      .map(toConversation);
  }

  async getConversation(key: string): Promise<ConversationRow | null> {
    const rows = this.sql.exec("SELECT * FROM conversations WHERE key = ?", key).toArray();
    return rows.length ? toConversation(rows[0]) : null;
  }

  async addOrder(order: OrderRow): Promise<void> {
    const { tenant, conversationKey, status, ...data } = order;
    this.sql.exec(
      "INSERT OR REPLACE INTO orders (ref, tenant, conversation_key, created_at, status, data) VALUES (?, ?, ?, ?, ?, ?)",
      order.reference, tenant, conversationKey, order.createdAt, status, JSON.stringify(data),
    );
  }

  async setOrderStatus(ref: string, status: OrderStatus): Promise<boolean> {
    return this.sql.exec("UPDATE orders SET status = ? WHERE ref = ?", status, ref).rowsWritten > 0;
  }

  async listOrders(tenant: string, limit = 200): Promise<OrderRow[]> {
    return this.sql
      .exec("SELECT * FROM orders WHERE tenant = ? ORDER BY created_at DESC LIMIT ?", tenant, limit)
      .toArray()
      .map((r) => ({
        ...(JSON.parse(String(r.data)) as Order),
        tenant: String(r.tenant),
        conversationKey: String(r.conversation_key),
        status: r.status as OrderStatus,
      }));
  }

  async addLead(lead: Lead): Promise<void> {
    this.sql.exec(
      "INSERT INTO leads (created_at, status, data) VALUES (?, 'nouvelle', ?)",
      lead.createdAt, JSON.stringify(lead),
    );
  }

  async setLeadStatus(id: number, status: LeadStatus): Promise<boolean> {
    return this.sql.exec("UPDATE leads SET status = ? WHERE id = ?", status, id).rowsWritten > 0;
  }

  async listLeads(limit = 200): Promise<LeadRow[]> {
    return this.sql
      .exec("SELECT * FROM leads ORDER BY created_at DESC LIMIT ?", limit)
      .toArray()
      .map((r) => ({ ...(JSON.parse(String(r.data)) as Lead), id: Number(r.id), status: r.status as LeadStatus }));
  }

  async overview(tenant: string, now: number): Promise<Overview> {
    const count = (query: string, ...args: (string | number)[]) =>
      Number(this.sql.exec(query, ...args).one().n);
    const startOfDay = now - (now % 86_400_000);
    return {
      newOrders: count("SELECT COUNT(*) AS n FROM orders WHERE tenant = ? AND status = 'nouvelle'", tenant),
      waitingForTeam: count(
        "SELECT COUNT(*) AS n FROM conversations WHERE tenant = ? AND status = 'equipe' AND test = 0",
        tenant,
      ),
      conversationsToday: count(
        "SELECT COUNT(*) AS n FROM conversations WHERE tenant = ? AND last_at >= ? AND test = 0",
        tenant, startOfDay,
      ),
      ordersThisWeek: count(
        "SELECT COUNT(*) AS n FROM orders WHERE tenant = ? AND created_at >= ? AND status != 'annulee'",
        tenant, now - 7 * 86_400_000,
      ),
      newLeads: count("SELECT COUNT(*) AS n FROM leads WHERE status = 'nouvelle'"),
    };
  }
}

function toConversation(r: Record<string, SqlStorageValue>): ConversationRow {
  return {
    key: String(r.key),
    tenant: String(r.tenant),
    channel: r.channel as Channel,
    customerId: String(r.customer_id),
    name: r.name === null ? null : String(r.name),
    phone: r.phone === null ? null : String(r.phone),
    lastText: String(r.last_text),
    lastFrom: r.last_from as ConversationRow["lastFrom"],
    lastAt: Number(r.last_at),
    status: r.status as ConversationStatus,
    test: Number(r.test) === 1,
  };
}
