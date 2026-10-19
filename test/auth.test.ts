import { describe, expect, it } from "vitest";
import { createToken, samePassword, SESSION_MS, verifyToken } from "../src/auth";

describe("connexion à l'application", () => {
  it("accepte un jeton valide jusqu'à son expiration", async () => {
    const token = await createToken("secret", 1000);
    expect(await verifyToken("secret", token, 2000)).toBe(true);
    expect(await verifyToken("secret", token, 1000 + SESSION_MS + 1)).toBe(false);
  });

  it("refuse un jeton modifié ou signé avec un autre mot de passe", async () => {
    const token = await createToken("secret", 1000);
    const [, mac] = token.split(".");
    expect(await verifyToken("autre", token, 2000)).toBe(false);
    expect(await verifyToken("secret", `${9e15}.${mac}`, 2000)).toBe(false);
    expect(await verifyToken("secret", "n'importe quoi", 2000)).toBe(false);
  });

  it("compare les mots de passe", async () => {
    expect(await samePassword("abc", "abc")).toBe(true);
    expect(await samePassword("abc", "abd")).toBe(false);
  });
});
