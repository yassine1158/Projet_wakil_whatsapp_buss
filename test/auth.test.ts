import { describe, expect, it } from "vitest";
import { createToken, hashPassword, samePassword, SESSION_MS, verifyPassword, verifyToken } from "../src/auth";

describe("sessions de l'application", () => {
  it("garde le rôle dans le jeton, jusqu'à son expiration", async () => {
    const admin = await createToken("secret", { kind: "admin" }, 1000);
    expect(await verifyToken("secret", admin, 2000)).toEqual({ kind: "admin" });
    const patron = await createToken("secret", { kind: "tenant", tenantId: "sicar" }, 1000);
    expect(await verifyToken("secret", patron, 2000)).toEqual({ kind: "tenant", tenantId: "sicar" });
    expect(await verifyToken("secret", admin, 1000 + SESSION_MS + 1)).toBeNull();
  });

  it("refuse un jeton modifié ou signé avec un autre secret", async () => {
    const patron = await createToken("secret", { kind: "tenant", tenantId: "sicar" }, 1000);
    const [, expires, mac] = patron.split(".");
    expect(await verifyToken("autre", patron, 2000)).toBeNull();
    // Se faire passer pour l'administrateur en changeant le rôle : refusé.
    expect(await verifyToken("secret", `admin.${expires}.${mac}`, 2000)).toBeNull();
    expect(await verifyToken("secret", "n'importe quoi", 2000)).toBeNull();
  });

  it("vérifie les mots de passe des patrons sans les garder en clair", async () => {
    const stored = await hashPassword("Sable-Camion-58");
    expect(stored).toMatch(/^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored).not.toContain("Sable");
    expect(await verifyPassword("Sable-Camion-58", stored)).toBe(true);
    expect(await verifyPassword("sable-camion-58", stored)).toBe(false);
    expect(await hashPassword("Sable-Camion-58")).not.toBe(stored); // sel différent
  });

  it("compare le mot de passe administrateur", async () => {
    expect(await samePassword("abc", "abc")).toBe(true);
    expect(await samePassword("abc", "abd")).toBe(false);
  });
});
