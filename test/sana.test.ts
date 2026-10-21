import { describe, expect, it } from "vitest";
import { formatBusinessInfo, formatCatalog, loadCatalog, parseDocument } from "../src/catalog";
import { buildSystemPrompt } from "../src/prompt";
import tenants from "../config/tenants.json";
import type { Tenant } from "../src/types";
// Copie des vraies données du site SANA (data/content.js du dépôt WEBSITE-SANA-).
import sana from "./fixtures/sana-content.json";

// Le fichier tel que le publie l'administration du site
const content = `window.SANA_CONTENT = ${JSON.stringify(sana, null, 2)};\n`;
const tenant = (tenants as unknown as Tenant[]).find((t) => t.id === "sana")!;
const fakeFetch = (async (url: string) => {
  expect(url).toBe("https://sana-sa.ci/data/content.js");
  return new Response(content, { headers: { "content-type": "application/javascript" } });
}) as unknown as typeof fetch;

describe("catalogue SANA (data/content.js du site)", () => {
  it("lit le fichier « window.SANA_CONTENT = {…}; »", () => {
    expect(parseDocument(content)).toHaveProperty("company.name", "SANA");
    expect(() => parseDocument("ceci n'est pas un catalogue", "x")).toThrow("Catalogue illisible");
  });

  it("transforme les produits du site, disponibles ou « bientôt »", async () => {
    const catalog = await loadCatalog(tenant, fakeFetch);
    const byName = Object.fromEntries(catalog.products.map((p) => [p.name, p]));
    expect(byName["Œufs à couver"]).toMatchObject({ id: "oeufs-a-couver", available: true, unit: "œuf" });
    expect(byName["Poussins de chair"]).toMatchObject({ id: "poussins", available: true, unit: "poussin" });
    expect(byName["Poussins de chair"].description).toContain("28 octobre 2026");
    expect(byName["Aliments pour tous les animaux"]).toMatchObject({ available: false });
    expect(byName["Aliments pour tous les animaux"].description).toContain("Volailles");
    // offre masquée sur le site : absente pour Wakil
    expect(catalog.products.some((p) => /abattage/i.test(p.name))).toBe(false);
  });

  it("reprend les coordonnées, les horaires et la FAQ du site", async () => {
    const { info } = await loadCatalog(tenant, fakeFetch);
    expect(info).toMatchObject({ phone: "+2250715500000", address: "Yamoussoukro, Côte d'Ivoire" });
    expect(info.hours).toMatch(/7 h/);
    expect(info.faq.length).toBeGreaterThan(0);
    expect(formatBusinessInfo(info)).toContain("Société Afriqaine de Nutrition Animale");
  });

  it("donne au modèle les règles propres à SANA", async () => {
    const catalog = await loadCatalog(tenant, fakeFetch);
    const prompt = buildSystemPrompt(tenant, catalog, "web");
    expect(prompt).toContain("Poussins de chair [id: poussins]");
    expect(prompt).toContain("ACTUELLEMENT INDISPONIBLE");
    expect(prompt).toContain("confidentielles");
    expect(prompt).toContain("aucun diagnostic");
    expect(tenant.webOrigins).toContain("https://sana-sa.ci");
    // le chat du site affiche déjà l'accueil : pas de deuxième présentation
    expect(prompt).not.toContain("présente-toi brièvement");
    expect(buildSystemPrompt(tenant, catalog, "whatsapp")).toContain("présente-toi brièvement");
  });

  it("affiche tel quel un prix déjà rédigé sur le site", () => {
    const text = formatCatalog({ products: [{ id: "a", name: "A", category: "", usages: [], price: "650 FCFA par poussin", unit: "poussin", available: true }], info: { faq: [] } });
    expect(text).toContain("Prix : 650 FCFA par poussin");
    expect(text).not.toContain("FCFA / poussin");
  });
});
