import { describe, expect, it } from "vitest";
import { explainError } from "../src/diagnostic";

describe("explication des erreurs de Claude", () => {
  it("dit quoi faire selon l'erreur", () => {
    expect(explainError(401, "authentication_error", "invalid x-api-key")).toContain("ANTHROPIC_API_KEY");
    expect(explainError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")).toContain("Billing");
    expect(explainError(404, "not_found_error", "model: x")).toContain("CLAUDE_MODEL");
    expect(explainError(429, "rate_limit_error", "")).toContain("minute");
    expect(explainError(529, "overloaded_error", "")).toContain("surchargé");
    expect(explainError(undefined, undefined, "fetch failed")).toContain("Connexion");
  });
});
