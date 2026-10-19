import wakil from "../config/wakil.json";
import { normalizePhone } from "./engine";
import type { Env } from "./types";
import { WhatsAppClient } from "./whatsapp";

/** Demande envoyée par une entreprise depuis le formulaire « Essayer Wakil ». */
export interface Lead {
  createdAt: number;
  name: string;
  company: string;
  sector: string;
  city: string;
  phone: string;
  message: string;
}

const LIMITS = { name: 80, company: 120, sector: 60, city: 80, message: 1000 };
const isPlaceholder = (v: string) => !v || /^REMPLACER|^2250000000000$/.test(v);

function field(body: Record<string, unknown>, key: keyof typeof LIMITS): string | null {
  const v = typeof body[key] === "string" ? (body[key] as string).trim() : "";
  return v.length <= LIMITS[key] ? v : null;
}

export function parseLead(body: Record<string, unknown>, now: number): Lead | { error: string } {
  const name = field(body, "name"), company = field(body, "company"), sector = field(body, "sector");
  const city = field(body, "city"), message = field(body, "message");
  if (name === null || company === null || sector === null || city === null || message === null) {
    return { error: "too_long" };
  }
  if (!name || !company) return { error: "missing_fields" };
  // Numéro international obligatoire : Wakil vise plusieurs pays.
  const raw = typeof body.phone === "string" ? body.phone : "";
  const phone = /^\s*(\+|00)/.test(raw) ? normalizePhone(raw) : undefined;
  if (!phone) return { error: "invalid_phone" };
  return { createdAt: now, name, company, sector, city, phone, message };
}

export function formatLead(lead: Lead): string {
  return [
    "🚀 Nouvelle demande pour Wakil",
    `Nom : ${lead.name}`,
    `Entreprise : ${lead.company}`,
    lead.sector && `Secteur : ${lead.sector}`,
    lead.city && `Ville : ${lead.city}`,
    `Téléphone : +${lead.phone}`,
    lead.message && `Message : ${lead.message}`,
    `Répondre : https://wa.me/${lead.phone}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** POST /leads, appelé par le formulaire du site de Wakil (même origine). */
export async function handleLead(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  // Champ invisible pour les humains : s'il est rempli, c'est un robot. On fait comme si tout allait bien.
  if (typeof body.website === "string" && body.website) return json({ ok: true }, 200);

  if (env.CHAT_LIMITER) {
    const { success } = await env.CHAT_LIMITER.limit({ key: `lead:${request.headers.get("cf-connecting-ip") ?? "inconnu"}` });
    if (!success) return json({ error: "rate_limited" }, 429);
  }

  const lead = parseLead(body, Date.now());
  if ("error" in lead) return json(lead, 400);

  await env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("wakil:leads")).saveLead(lead);

  const { ownerPhone, senderPhoneNumberId } = wakil.leads;
  if (!isPlaceholder(ownerPhone) && !isPlaceholder(senderPhoneNumberId)) {
    await new WhatsAppClient(env.WHATSAPP_TOKEN, senderPhoneNumberId, env.GRAPH_API_VERSION)
      .sendText(ownerPhone, formatLead(lead))
      .catch((e) => console.error("Notification de la demande échouée", e));
  }
  return json({ ok: true }, 200);
}
