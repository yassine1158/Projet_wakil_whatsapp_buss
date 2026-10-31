import { bytesToHex, timingSafeEqual } from "./encoding";
import type { IncomingMessage } from "./types";

/** Limite de Meta pour le corps d'un message texte. */
export const MAX_TEXT_LENGTH = 4096;

type FetchLike = typeof fetch;

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
};

/** Vérifie l'en-tête X-Hub-Signature-256 envoyé par Meta (HMAC-SHA256 du corps brut). */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(bytesToHex(new Uint8Array(mac)), header.slice("sha256=".length));
}

export interface WebhookMessage {
  phoneNumberId: string;
  message: IncomingMessage;
}

/** Extrait les messages entrants d'une notification webhook (les statuts sont ignorés). */
export function parseWebhook(payload: unknown): WebhookMessage[] {
  const out: WebhookMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: unknown[] }[]) {
    for (const change of (entry.changes ?? []) as { field?: string; value?: any }[]) {
      if (change.field !== "messages" || !change.value?.messages) continue;
      const value = change.value;
      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id && c?.profile?.name) names.set(c.wa_id, c.profile.name);
      }
      for (const m of value.messages) {
        const message = normalizeMessage(m, names.get(m.from));
        if (message) out.push({ phoneNumberId, message });
      }
    }
  }
  return out;
}

function normalizeMessage(m: any, name: string | undefined): IncomingMessage | null {
  if (!m?.id || !m?.from || !m?.type) return null;
  const base = {
    id: String(m.id),
    from: String(m.from),
    name,
    timestamp: Number(m.timestamp) * 1000 || Date.now(),
    rawType: String(m.type),
  };
  switch (m.type) {
    case "text":
      return { ...base, kind: "text", text: m.text?.body ?? "" };
    case "audio":
      return { ...base, kind: "audio", mediaId: m.audio?.id, mimeType: m.audio?.mime_type };
    case "image":
      return {
        ...base,
        kind: "image",
        mediaId: m.image?.id,
        mimeType: m.image?.mime_type,
        text: m.image?.caption,
      };
    case "location":
      return {
        ...base,
        kind: "location",
        location: {
          latitude: Number(m.location?.latitude),
          longitude: Number(m.location?.longitude),
          name: m.location?.name,
          address: m.location?.address,
        },
      };
    case "button":
      return { ...base, kind: "text", text: m.button?.text ?? "" };
    case "interactive": {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return { ...base, kind: "text", text: reply?.title ?? "" };
    }
    case "reaction":
    case "system":
    case "unsupported":
      return null;
    default:
      return { ...base, kind: "unsupported" };
  }
}

/** Découpe un texte trop long pour WhatsApp, de préférence sur un saut de ligne. */
export function splitForWhatsApp(text: string, max = MAX_TEXT_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Client minimal de l'API WhatsApp Cloud (Graph API). */
export class WhatsAppClient {
  private readonly base: string;

  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
    apiVersion = "v23.0",
    // Enveloppé : dans les Workers, appeler fetch comme méthode d'un objet lève "Illegal invocation".
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.base = `https://graph.facebook.com/${apiVersion}`;
  }

  async sendText(to: string, body: string): Promise<void> {
    for (const part of splitForWhatsApp(body)) {
      await this.send({ to, type: "text", text: { body: part, preview_url: false } });
    }
  }

  async sendImage(to: string, link: string, caption?: string): Promise<void> {
    await this.send({ to, type: "image", image: caption ? { link, caption } : { link } });
  }

  /**
   * Envoie un fichier audio : téléversé chez Meta, puis envoyé par son identifiant.
   * Seul un OGG/OPUS s'affiche comme message vocal ; un MP3 part comme fichier audio.
   */
  async sendAudio(to: string, audio: Uint8Array, mimeType: string): Promise<void> {
    const id = await this.uploadMedia(audio, mimeType);
    await this.send({ to, type: "audio", audio: mimeType.startsWith("audio/ogg") ? { id, voice: true } : { id } });
  }

  /** Téléverse un média chez Meta (valable 30 jours) et renvoie son identifiant. */
  async uploadMedia(bytes: Uint8Array, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), `wakil.${AUDIO_EXTENSIONS[mimeType] ?? "bin"}`);
    const res = await this.request(`${this.base}/${this.phoneNumberId}/media`, { method: "POST", body: form });
    const { id } = (await res.json()) as { id?: string };
    if (!id) throw new WhatsAppError("Média refusé par WhatsApp", res.status);
    return id;
  }

  async sendTemplate(to: string, name: string, language: string, bodyParams: string[]) {
    await this.send({
      to,
      type: "template",
      template: {
        name,
        language: { code: language },
        components: [
          { type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) },
        ],
      },
    });
  }

  /** Marque le message comme lu et affiche "en train d'écrire…" chez le client. */
  async markReadWithTyping(messageId: string): Promise<void> {
    await this.post(`/${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  }

  /** Télécharge un média reçu (vocal, photo) à partir de son identifiant. */
  async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const meta = await this.request(`${this.base}/${mediaId}`, { method: "GET" });
    const info = (await meta.json()) as { url?: string; mime_type?: string };
    if (!info.url) throw new WhatsAppError("Média introuvable", meta.status);
    const file = await this.request(info.url, { method: "GET" });
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: info.mime_type ?? file.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    await this.post(`/${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...message,
    });
  }

  private async post(path: string, body: unknown): Promise<void> {
    await this.request(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
      throw new WhatsAppError(
        detail.error?.message ?? `Erreur WhatsApp ${res.status}`,
        res.status,
        detail.error?.code,
      );
    }
    return res;
  }
}
