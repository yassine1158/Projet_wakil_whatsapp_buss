import { describe, expect, it } from "vitest";
import { runAgent, type ClaudeClient } from "../src/agent";
import { CLAUDE_RETRY_MS, fromChatCompletion, toChatMessages, withFreeFallback, workersAiClient } from "../src/free-model";
import type { ToolContext } from "../src/tools";

const catalog = {
  businessName: "SICAR",
  products: [{ id: "gravier-15-25", name: "Gravier 15/25", category: "Gravier", description: "", price: "12 000", unit: "tonne", available: true, imageUrl: "https://x/g.jpg" }],
  info: {},
} as unknown as ToolContext["catalog"];

describe("modèle gratuit (Workers AI)", () => {
  it("traduit l'historique Claude en messages de chat", () => {
    const messages = toChatMessages({
      system: [{ type: "text", text: "Tu es le commercial." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Bonjour" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } }] },
        { role: "assistant", content: [{ type: "text", text: "Voici" }, { type: "tool_use", id: "toolu_1", name: "send_product_photo", input: { product_id: "g" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Photo envoyée" }, { type: "text", text: "Merci" }] },
      ],
    });
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(messages[0].content).toMatch(/^Tu es le commercial\./);
    expect(messages[1].content).toContain("photo que tu ne peux pas voir");
    expect(messages[2].tool_calls).toEqual([{ id: "toolu_1", type: "function", function: { name: "send_product_photo", arguments: '{"product_id":"g"}' } }]);
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "Photo envoyée" });
  });

  it("lit les deux formats de réponse de Workers AI", () => {
    const chat = fromChatCompletion(
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "call.1", type: "function", function: { name: "record_order", arguments: '{"a":1}' } }] } }] },
      "m",
    );
    expect(chat.stop_reason).toBe("tool_use");
    expect(chat.content).toEqual([{ type: "tool_use", id: "call_1", name: "record_order", input: { a: 1 } }]);

    const legacy = fromChatCompletion({ response: "<think>hmm</think> Bonjour !", tool_calls: [] }, "m");
    expect(legacy.stop_reason).toBe("end_turn");
    expect(legacy.content).toEqual([{ type: "text", text: "Bonjour !", citations: null }]);
  });

  it("fait tourner la boucle d'outils du commercial", async () => {
    const calls: Record<string, any>[] = [];
    const answers = [
      { choices: [{ message: { content: "Je vous montre le gravier.", tool_calls: [{ id: "c1", function: { name: "send_product_photo", arguments: { product_id: "gravier-15-25" } } }] } }] },
      { choices: [{ finish_reason: "stop", message: { content: "Il est à 12 000 FCFA la tonne." } }] },
    ];
    const client = workersAiClient(async (_model, input) => {
      calls.push(input);
      return answers[calls.length - 1];
    });
    const photos: string[] = [];
    const result = await runAgent(client, { model: "x", effort: "low" }, "Système", [], [{ type: "text", text: "Vous avez du gravier ?" }], {
      catalog,
      sendImage: async (link) => void photos.push(link),
      saveOrder: async () => null,
      requestHuman: async () => false,
    });
    expect(photos).toEqual(["https://x/g.jpg"]);
    expect(result.replies).toEqual(["Je vous montre le gravier.", "Il est à 12 000 FCFA la tonne."]);
    expect(calls[0].tools.map((t: any) => t.function.name)).toContain("record_order");
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });
});

describe("relais quand Claude ne répond pas", () => {
  const reply = (text: string): ClaudeClient => ({
    beta: { messages: { create: async () => ({ content: [{ type: "text", text }] }) as any } },
  });
  const failing = (status: number, message: string) => {
    let n = 0;
    const client: ClaudeClient = {
      beta: { messages: { create: async () => { n++; throw Object.assign(new Error(message), { status }); } } },
    };
    return { client, count: () => n };
  };
  const text = async (c: ClaudeClient) => ((await c.beta.messages.create({} as any)).content[0] as any).text;

  it("garde Claude quand il répond", async () => {
    expect(await text(withFreeFallback(reply("claude"), reply("gratuit"), { state: { claudeDownUntil: 0 }, log: () => {} }))).toBe("claude");
  });

  it("passe au gratuit sans clé, et sur crédit épuisé n'insiste pas pendant 10 minutes", async () => {
    expect(await text(withFreeFallback(null, reply("gratuit"), { log: () => {} }))).toBe("gratuit");

    let now = 1_000;
    const state = { claudeDownUntil: 0 };
    const claude = failing(400, "Your credit balance is too low to access the Anthropic API.");
    const client = withFreeFallback(claude.client, reply("gratuit"), { now: () => now, state, log: () => {} });
    expect(await text(client)).toBe("gratuit");
    expect(await text(client)).toBe("gratuit");
    expect(claude.count()).toBe(1);
    now += CLAUDE_RETRY_MS;
    await text(client);
    expect(claude.count()).toBe(2);
  });

  it("réessaie Claude au tour suivant après une simple surcharge", async () => {
    const state = { claudeDownUntil: 0 };
    const claude = failing(529, "Overloaded");
    const client = withFreeFallback(claude.client, reply("gratuit"), { state, log: () => {} });
    expect(await text(client)).toBe("gratuit");
    await text(client);
    expect(claude.count()).toBe(2);
  });
});
