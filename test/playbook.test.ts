import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/catalog";
import { PERSONALITY, PLAYBOOK } from "../src/playbook";
import { buildSystemPrompt } from "../src/prompt";
import tenants from "../config/tenants.json";
import type { Tenant } from "../src/types";
// Copies des vraies données des sites SICAR et SANA.
import sana from "./fixtures/sana-content.json";
import sicarProducts from "./fixtures/sicar-products.json";
import sicarSite from "./fixtures/sicar-site.json";

const files: Record<string, string> = {
  "https://yassine1158.github.io/SICAR_SARL/data/products.json": JSON.stringify(sicarProducts),
  "https://yassine1158.github.io/SICAR_SARL/data/site.json": JSON.stringify(sicarSite),
  "https://sana-sa.ci/data/content.js": `window.SANA_CONTENT = ${JSON.stringify(sana)};`,
};
const fakeFetch = (async (url: string) => new Response(files[url], { status: files[url] ? 200 : 404 })) as unknown as typeof fetch;

const all = tenants as unknown as Tenant[];

describe("personnalité et méthode de vente", () => {
  it("sont données au modèle pour chaque entreprise, sur WhatsApp comme sur le site", async () => {
    for (const tenant of all) {
      const catalog = await loadCatalog(tenant, fakeFetch);
      for (const channel of ["whatsapp", "web"] as const) {
        const prompt = buildSystemPrompt(tenant, catalog, channel);
        expect(prompt).toContain(PERSONALITY);
        expect(prompt).toContain(PLAYBOOK);
        // les consignes de l'entreprise viennent après, pour pouvoir ajuster le ton
        if (tenant.instructions) expect(prompt.indexOf(tenant.instructions)).toBeGreaterThan(prompt.indexOf(PLAYBOOK));
      }
    }
  });

  it("restent communes à toutes les entreprises : aucun de leurs produits n'y est cité", async () => {
    const shared = `${PERSONALITY}\n${PLAYBOOK}`.toLowerCase();
    for (const tenant of all) {
      const { products } = await loadCatalog(tenant, fakeFetch);
      expect(products.length).toBeGreaterThan(0);
      for (const p of products) expect(shared).not.toContain(p.name.toLowerCase());
    }
    for (const word of ["gravier", "sable", "chantier", "poussin", "élevage"]) expect(shared).not.toContain(word);
  });
});
