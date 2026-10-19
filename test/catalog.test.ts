import { describe, expect, it } from "vitest";
import { formatBusinessInfo, formatCatalog, normalizeInfo, normalizeProducts } from "../src/catalog";
import { buildSystemPrompt } from "../src/prompt";
import tenants from "../config/tenants.json";
import type { Tenant } from "../src/types";
// Copie des vraies données du site SICAR (data/products.json et data/site.json du dépôt SICAR_SARL).
import products from "./fixtures/sicar-products.json";
import site from "./fixtures/sicar-site.json";

const tenant = Object.values(tenants)[0] as unknown as Tenant;

describe("catalogue SICAR", () => {
  const catalog = {
    products: normalizeProducts(products, tenant.catalog.assetBaseUrl),
    info: normalizeInfo(site),
  };

  it("lit tous les produits avec des URL d'image absolues", () => {
    expect(catalog.products.length).toBe(products.length);
    const gravier = catalog.products.find((p) => p.id === "gravier-15-25")!;
    expect(gravier).toMatchObject({ name: "Gravier 15/25", unit: "tonne", price: "", available: true });
    expect(gravier.imageUrl).toMatch(/^https:\/\/yassine1158\.github\.io\/SICAR_SARL\/assets\/img\//);
  });

  it("affiche « sur devis » quand le prix est vide", () => {
    const text = formatCatalog(catalog);
    expect(text).toContain("Gravier 15/25 [id: gravier-15-25]");
    expect(text).toContain("sur devis (vendu à la tonne)");
    expect(text).not.toContain("FCFA");
  });

  it("met les infos et la FAQ dans le prompt, sans élément variable", () => {
    expect(formatBusinessInfo(catalog.info)).toContain("Comment passer commande ?");
    const a = buildSystemPrompt(tenant, catalog, "whatsapp");
    const b = buildSystemPrompt(tenant, catalog, "whatsapp");
    expect(a).toBe(b);
    expect(a).toContain("SICAR SARL");
    expect(a).toContain("record_order");
    const web = buildSystemPrompt(tenant, catalog, "web");
    expect(web).toContain("customer_phone");
    expect(a).not.toContain("demande-lui son numéro");
  });

  it("ignore les entrées invalides", () => {
    expect(normalizeProducts({ not: "an array" }, "https://x/")).toEqual([]);
    expect(normalizeProducts([{ id: 1 }, { id: "ok", name: "Ok" }], "https://x/")).toHaveLength(1);
  });
});
