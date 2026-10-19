import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClaudeClient } from "../src/agent";
import { REFUSAL_REPLY } from "../src/agent";
import {
  addIncoming,
  enqueueMessage,
  normalizePhone,
  processPending,
  TECHNICAL_ISSUE_REPLY,
  WEB_HANDOFF_REPLY,
  type ConversationStorage,
  type EngineDeps,
  type WhatsAppSender,
} from "../src/engine";
import type { Catalog, IncomingMessage, Order, Tenant } from "../src/types";

class MemoryStorage implements ConversationStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(time: number) {
    this.alarm = time;
  }
}

class FakeWhatsApp implements WhatsAppSender {
  sent: { to: string; kind: string; body: string }[] = [];
  read: string[] = [];
  async sendText(to: string, body: string) {
    this.sent.push({ to, kind: "text", body });
  }
  async sendImage(to: string, link: string, caption?: string) {
    this.sent.push({ to, kind: "image", body: `${link} ${caption ?? ""}`.trim() });
  }
  async sendTemplate(to: string, name: string, _lang: string, params: string[]) {
    this.sent.push({ to, kind: `template:${name}`, body: params.join() });
  }
  async markReadWithTyping(id: string) {
    this.read.push(id);
  }
  async downloadMedia() {
    return { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" };
  }
}

/** Faux client Claude : renvoie les réponses prévues, dans l'ordre, et garde les requêtes. */
function fakeClaude(responses: Partial<Anthropic.Beta.BetaMessage>[]) {
  const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        async create(params) {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("Pas de réponse prévue");
          return next as Anthropic.Beta.BetaMessage;
        },
      },
    },
  };
  return { client, requests };
}

const tenant: Tenant = {
  id: "sicar",
  businessName: "SICAR SARL",
  assistantName: "Wakil",
  ownerPhone: "22599",
  timezone: "Africa/Abidjan",
  catalog: { productsUrl: "https://x/p.json", assetBaseUrl: "https://x/" },
};

const catalog: Catalog = {
  products: [
    {
      id: "gravier-15-25",
      name: "Gravier 15/25",
      category: "gravier",
      usages: ["Béton"],
      price: "",
      unit: "tonne",
      imageUrl: "https://x/g.jpg",
      available: true,
    },
  ],
  info: { faq: [] },
};

const NOW = 1_760_000_000_000;
const CLIENT = "22507";

const msg = (id: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id,
  from: CLIENT,
  name: "Kouassi",
  timestamp: NOW,
  kind: "text",
  text: "Bonjour",
  rawType: "text",
  ...extra,
});

let storage: MemoryStorage;
let whatsapp: FakeWhatsApp;

function deps(claude: ClaudeClient, overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    storage,
    tenant,
    whatsapp,
    claude,
    agentConfig: { model: "claude-opus-5-5", effort: "low" },
    transcribe: async () => "il me faut du gravier pour une dalle",
    loadCatalog: async () => catalog,
    now: () => NOW,
    log: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  storage = new MemoryStorage();
  whatsapp = new FakeWhatsApp();
});

describe("enqueueMessage", () => {
  it("ignore les doublons et regroupe les messages rapprochés", async () => {
    expect(await enqueueMessage(storage, "PNID", msg("m1"), NOW, 4000)).toBe(true);
    expect(await enqueueMessage(storage, "PNID", msg("m1"), NOW + 100, 4000)).toBe(false);
    expect(await enqueueMessage(storage, "PNID", msg("m2"), NOW + 2000, 4000)).toBe(true);
    expect((await storage.get<IncomingMessage[]>("pending"))!.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(storage.alarm).toBe(NOW + 6000);
    // Jamais plus de 15 s après le premier message.
    await enqueueMessage(storage, "PNID", msg("m3"), NOW + 14_000, 4000);
    expect(storage.alarm).toBe(NOW + 15_000);
  });
});

describe("processPending", () => {
  it("répond, enregistre la commande et prévient le patron", async () => {
    await enqueueMessage(storage, "PNID", msg("m1", { text: "Je veux 14 tonnes de 15/25 livrées à Yopougon, c'est confirmé" }), NOW, 4000);
    await enqueueMessage(storage, "PNID", msg("m2", { kind: "audio", text: undefined, mediaId: "a1", rawType: "audio" }), NOW + 1, 4000);

    const { client, requests } = fakeClaude([
      {
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig" } as Anthropic.Beta.BetaContentBlock,
          {
            type: "tool_use",
            id: "t1",
            name: "record_order",
            input: {
              customer_name: "Kouassi",
              items: [{ product_id: "gravier-15-25", quantity: 14 }],
              fulfilment: "livraison",
              delivery_location: "Yopougon",
            },
          } as Anthropic.Beta.BetaContentBlock,
        ],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "C'est noté ✓ Votre référence : W-1." } as Anthropic.Beta.BetaContentBlock],
      },
    ]);

    await processPending(deps(client));

    // Une seule réponse pour les deux messages, vocal transcrit inclus.
    const firstUser = requests[0].messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    expect(firstUser.map((b) => (b.type === "text" ? b.text : b.type))).toEqual([
      expect.stringContaining("Client WhatsApp : Kouassi (+22507)"),
      "Je veux 14 tonnes de 15/25 livrées à Yopougon, c'est confirmé",
      "[Message vocal, transcription automatique] il me faut du gravier pour une dalle",
    ]);
    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low" } });
    expect(whatsapp.read).toEqual(["m2"]);

    const toOwner = whatsapp.sent.filter((s) => s.to === "22599");
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0].body).toContain("Gravier 15/25 : 14 tonnes");
    expect(toOwner[0].body).toContain("Livraison : Yopougon");

    expect(whatsapp.sent.filter((s) => s.to === CLIENT)).toEqual([
      { to: CLIENT, kind: "text", body: "C'est noté ✓ Votre référence : W-1." },
    ]);
    expect(await storage.get<Order[]>("orders")).toHaveLength(1);
    expect(await storage.get("pending")).toBeUndefined();

    // Historique gardé sans les blocs de réflexion.
    const history = (await storage.get<Anthropic.Beta.BetaMessageParam[]>("history"))!;
    expect(history).toHaveLength(4);
    expect(JSON.stringify(history)).not.toContain('"thinking"');
  });

  it("refuse une commande avec un produit inconnu et laisse le modèle corriger", async () => {
    await enqueueMessage(storage, "PNID", msg("m1"), NOW, 4000);
    const { client, requests } = fakeClaude([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "record_order",
            input: { customer_name: "K", items: [{ product_id: "ciment", quantity: 2 }], fulfilment: "enlevement" },
          } as Anthropic.Beta.BetaContentBlock,
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Nous ne vendons pas de ciment." } as Anthropic.Beta.BetaContentBlock] },
    ]);
    await processPending(deps(client));
    const toolResult = (requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
    expect(toolResult).toMatchObject({ is_error: true, content: "Produit inconnu : ciment" });
    expect(whatsapp.sent.filter((s) => s.to === "22599")).toHaveLength(0);
  });

  it("passe la main à un conseiller puis se tait", async () => {
    await enqueueMessage(storage, "PNID", msg("m1", { text: "Je veux parler à quelqu'un" }), NOW, 4000);
    const { client } = fakeClaude([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "request_human", input: { reason: "demande", summary: "veut un humain" } } as Anthropic.Beta.BetaContentBlock,
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Un conseiller va vous rappeler." } as Anthropic.Beta.BetaContentBlock] },
    ]);
    await processPending(deps(client));
    expect(whatsapp.sent.find((s) => s.to === "22599")?.body).toContain("#reprendre 22507");

    whatsapp.sent = [];
    await enqueueMessage(storage, "PNID", msg("m2", { text: "Allô ?" }), NOW + 60_000, 4000);
    const silent = fakeClaude([]);
    await processPending(deps(silent.client, { now: () => NOW + 60_000 }));
    expect(silent.requests).toHaveLength(0);
    expect(whatsapp.sent).toEqual([{ to: "22599", kind: "text", body: expect.stringContaining("Allô ?") }]);
  });

  it("gère un refus et une panne de l'API", async () => {
    await enqueueMessage(storage, "PNID", msg("m1"), NOW, 4000);
    await processPending(deps(fakeClaude([{ stop_reason: "refusal", content: [] }]).client));
    expect(whatsapp.sent).toEqual([{ to: CLIENT, kind: "text", body: REFUSAL_REPLY }]);

    whatsapp.sent = [];
    await enqueueMessage(storage, "PNID", msg("m2"), NOW, 4000);
    await processPending(deps(fakeClaude([]).client));
    expect(whatsapp.sent.map((s) => s.to)).toEqual([CLIENT, "22599"]);
    expect(whatsapp.sent[0].body).toBe(TECHNICAL_ISSUE_REPLY);
  });

  it("utilise le modèle de message approuvé pour le patron s'il est configuré", async () => {
    await enqueueMessage(storage, "PNID", msg("m1"), NOW, 4000);
    const { client } = fakeClaude([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "record_order",
            input: { customer_name: "K", items: [{ product_id: "gravier-15-25", quantity: 1 }], fulfilment: "enlevement" },
          } as Anthropic.Beta.BetaContentBlock,
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Noté." } as Anthropic.Beta.BetaContentBlock] },
    ]);
    await processPending(deps(client, { tenant: { ...tenant, ownerNotifyTemplate: { name: "nouvelle_demande", language: "fr" } } }));
    const owner = whatsapp.sent.find((s) => s.to === "22599")!;
    expect(owner.kind).toBe("template:nouvelle_demande");
    expect(owner.body).not.toContain("\n");
  });
});

describe("chat du site web", () => {
  const webMeta = { channel: "web" as const, phoneNumberId: "PNID", customerId: "session-abcdefgh12345678" };
  const webMsg = (id: string, text: string): IncomingMessage => ({
    id,
    from: webMeta.customerId,
    timestamp: NOW,
    kind: "text",
    text,
    rawType: "text",
  });
  const collector = () => {
    const replies: string[] = [];
    return { replies, sink: { sendText: async (t: string) => void replies.push(t), sendImage: async (u: string) => void replies.push(`[img] ${u}`) } };
  };
  const order = (extra: Record<string, unknown> = {}) =>
    ({
      type: "tool_use",
      id: `t${Object.keys(extra).length}`,
      name: "record_order",
      input: {
        customer_name: "Awa",
        items: [{ product_id: "gravier-15-25", quantity: 10 }],
        fulfilment: "livraison",
        delivery_location: "Cocody",
        ...extra,
      },
    }) as Anthropic.Beta.BetaContentBlock;

  it("demande le numéro avant d'enregistrer, puis prévient le patron", async () => {
    await addIncoming(storage, webMeta, webMsg("w1", "10 tonnes de 15/25 à Cocody, mon numéro : 07 07 07 07 07"));
    const { client, requests } = fakeClaude([
      { stop_reason: "tool_use", content: [order()] },
      { stop_reason: "tool_use", content: [order({ customer_phone: "07 07 07 07 07" })] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "C'est enregistré." } as Anthropic.Beta.BetaContentBlock] },
    ]);
    const { replies, sink } = collector();
    await processPending(deps(client, { sink, tenant: { ...tenant, defaultCountryCode: "225" } }));

    const firstResult = (requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
    expect(firstResult.is_error).toBe(true);
    expect(String(firstResult.content)).toContain("customer_phone");
    expect(JSON.stringify(requests[0].system)).toContain("Canal : le chat du site web");
    expect((requests[0].messages[0].content as Anthropic.Beta.BetaTextBlockParam[])[0].text).toContain("Visiteur du chat du site web");

    expect(replies).toEqual(["C'est enregistré."]);
    expect(whatsapp.read).toEqual([]);
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({ to: "22599" });
    expect(whatsapp.sent[0].body).toContain("via le site web");
    expect(whatsapp.sent[0].body).toContain("https://wa.me/2250707070707");
    expect((await storage.get<Order[]>("orders"))![0]).toMatchObject({ channel: "web", customerPhone: "2250707070707" });
  });

  it("répond au visiteur quand un conseiller a pris la main", async () => {
    await storage.put("handoffUntil", NOW + 1000);
    await addIncoming(storage, webMeta, webMsg("w1", "Vous êtes là ?"));
    const { replies, sink } = collector();
    const silent = fakeClaude([]);
    await processPending(deps(silent.client, { sink }));
    expect(silent.requests).toHaveLength(0);
    expect(replies).toEqual([WEB_HANDOFF_REPLY]);
    expect(whatsapp.sent[0].body).toContain("numéro inconnu");
  });
});

describe("démonstration", () => {
  it("ne prévient personne quand l'entreprise n'a pas de patron", async () => {
    await enqueueMessage(storage, "PNID", msg("m1"), NOW, 4000);
    const { client } = fakeClaude([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "request_human", input: { reason: "r", summary: "s" } } as Anthropic.Beta.BetaContentBlock,
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Ok." } as Anthropic.Beta.BetaContentBlock] },
    ]);
    await processPending(deps(client, { tenant: { ...tenant, ownerPhone: "" } }));
    expect(whatsapp.sent).toEqual([{ to: CLIENT, kind: "text", body: "Ok." }]);
  });
});

describe("normalizePhone", () => {
  it("garde le format international et complète les numéros locaux", () => {
    expect(normalizePhone("07 07 07 07 07", "225")).toBe("2250707070707");
    expect(normalizePhone("+225 07 07 07 07 07", "225")).toBe("2250707070707");
    expect(normalizePhone("00216 22 333 444", "225")).toBe("21622333444");
    expect(normalizePhone("+216 22 333 444", "225")).toBe("21622333444");
    expect(normalizePhone("2250707070707", "225")).toBe("2250707070707");
    expect(normalizePhone("123", "225")).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
  });
});
