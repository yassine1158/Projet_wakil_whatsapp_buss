import { DurableObject } from "cloudflare:workers";
import type { Lead } from "./leads";
import type { Channel, Env, Order, Tenant } from "./types";

export * from "./inbox-types";
import type {
  BrainSampleRow,
  BrainStats,
  ConversationRow,
  ConversationStatus,
  LeadRow,
  LeadStatus,
  OrderRow,
  OrderStatus,
  Overview,
  StoredTenant,
  TenantSecrets,
} from "./inbox-types";

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
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY, data TEXT NOT NULL, password_hash TEXT, wa_token TEXT, wa_pin TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS brain_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, at INTEGER NOT NULL, context TEXT NOT NULL,
        text TEXT NOT NULL, predicted TEXT NOT NULL, confidence REAL NOT NULL, teacher TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS brain_samples_by_tenant ON brain_samples (tenant, at);
    `);
  }

  /* ---------- Entreprises créées ou modifiées dans l'application ---------- */

  async listTenants(): Promise<StoredTenant[]> {
    return this.sql
      .exec("SELECT data, password_hash, wa_token, updated_at FROM tenants ORDER BY id")
      .toArray()
      .map((r) => ({
        tenant: JSON.parse(String(r.data)) as Tenant,
        hasPassword: r.password_hash !== null,
        hasWhatsappToken: r.wa_token !== null,
        updatedAt: Number(r.updated_at),
      }));
  }

  async saveTenant(tenant: Tenant, now: number): Promise<void> {
    this.sql.exec(
      `INSERT INTO tenants (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      tenant.id, JSON.stringify(tenant), now, now,
    );
  }

  async deleteTenant(id: string): Promise<boolean> {
    return this.sql.exec("DELETE FROM tenants WHERE id = ?", id).rowsWritten > 0;
  }

  async tenantSecrets(id: string): Promise<TenantSecrets | null> {
    const rows = this.sql.exec("SELECT password_hash, wa_token, wa_pin FROM tenants WHERE id = ?", id).toArray();
    if (!rows.length) return null;
    const r = rows[0];
    return {
      passwordHash: r.password_hash === null ? null : String(r.password_hash),
      whatsappToken: r.wa_token === null ? null : String(r.wa_token),
      whatsappPin: r.wa_pin === null ? null : String(r.wa_pin),
    };
  }

  async setTenantPassword(id: string, passwordHash: string): Promise<boolean> {
    return this.sql.exec("UPDATE tenants SET password_hash = ? WHERE id = ?", passwordHash, id).rowsWritten > 0;
  }

  async setTenantWhatsappSecrets(id: string, token: string | null, pin: string | null): Promise<boolean> {
    return this.sql.exec("UPDATE tenants SET wa_token = ?, wa_pin = ? WHERE id = ?", token, pin, id).rowsWritten > 0;
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

  async orderTenant(ref: string): Promise<string | null> {
    const rows = this.sql.exec("SELECT tenant FROM orders WHERE ref = ?", ref).toArray();
    return rows.length ? String(rows[0].tenant) : null;
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

  /* ---------- Wakil Brain (mode ombre) ---------- */

  async addBrainSample(sample: Omit<BrainSampleRow, "id">): Promise<void> {
    this.sql.exec(
      "INSERT INTO brain_samples (tenant, at, context, text, predicted, confidence, teacher) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sample.tenant, sample.at, sample.context, sample.text, sample.predicted, sample.confidence, sample.teacher,
    );
    // On garde les 20 000 derniers exemples.
    this.sql.exec("DELETE FROM brain_samples WHERE id <= (SELECT MAX(id) FROM brain_samples) - 20000");
  }

  async brainSamples(tenant: string | null, limit = 5000): Promise<BrainSampleRow[]> {
    const rows = tenant
      ? this.sql.exec("SELECT * FROM brain_samples WHERE tenant = ? ORDER BY id DESC LIMIT ?", tenant, limit)
      : this.sql.exec("SELECT * FROM brain_samples ORDER BY id DESC LIMIT ?", limit);
    return rows.toArray().map((r) => ({
      id: Number(r.id),
      tenant: String(r.tenant),
      at: Number(r.at),
      context: String(r.context),
      text: String(r.text),
      predicted: String(r.predicted),
      confidence: Number(r.confidence),
      teacher: String(r.teacher),
    }));
  }

  async brainStats(tenant: string | null): Promise<BrainStats> {
    const samples = await this.brainSamples(tenant, 20000);
    const byTeacher: BrainStats["byTeacher"] = {};
    for (const s of samples) {
      const t = (byTeacher[s.teacher] ??= { total: 0, agreed: 0 });
      t.total++;
      if (s.predicted === s.teacher) t.agreed++;
    }
    return {
      total: samples.length,
      agreed: samples.filter((s) => s.predicted === s.teacher).length,
      byTeacher,
      recent: samples.slice(0, 30),
    };
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
