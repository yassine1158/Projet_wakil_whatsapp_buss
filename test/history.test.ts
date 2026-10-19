import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { sanitizeHistory, trimHistory } from "../src/history";

type M = Anthropic.Beta.BetaMessageParam;

describe("sanitizeHistory", () => {
  it("retire la réflexion, remplace les photos et garde les échanges d'outils", () => {
    const history: M[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Voici mon chantier" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Je vous envoie la photo." },
          { type: "tool_use", id: "t1", name: "send_product_photo", input: { product_id: "x" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "zzz" }] },
    ];
    expect(sanitizeHistory(history)).toEqual([
      { role: "user", content: [{ type: "text", text: "Voici mon chantier" }, { type: "text", text: "[Photo envoyée par le client]" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Je vous envoie la photo." },
          { type: "tool_use", id: "t1", name: "send_product_photo", input: { product_id: "x" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]);
  });
});

describe("trimHistory", () => {
  const turn = (i: number): M[] => [
    { role: "user", content: `question ${i}` },
    { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] },
    { role: "assistant", content: `réponse ${i}` },
  ];

  it("coupe au début d'un tour du client, jamais au milieu d'un outil", () => {
    const history = [1, 2, 3, 4, 5].flatMap(turn);
    const trimmed = trimHistory(history, 6);
    expect(trimmed[0]).toEqual({ role: "user", content: "question 5" });
    expect(trimmed).toHaveLength(4);
  });

  it("ne change pas un historique court", () => {
    const history = turn(1);
    expect(trimHistory(history, 40)).toBe(history);
  });
});
