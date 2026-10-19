import type { BusinessInfo, Catalog, Product, Tenant } from "./types";

type FetchLike = typeof fetch;

/**
 * Charge le catalogue de l'entreprise depuis son site (format products.json / site.json
 * du site SICAR). Les réponses sont mises en cache 5 minutes par Cloudflare.
 */
export async function loadCatalog(tenant: Tenant, fetchFn: FetchLike = fetch): Promise<Catalog> {
  const get = async (url: string) => {
    const res = await fetchFn(url, { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit);
    if (!res.ok) throw new Error(`Catalogue indisponible (${res.status}) : ${url}`);
    return res.json();
  };
  const [rawProducts, rawSite] = await Promise.all([
    get(tenant.catalog.productsUrl),
    tenant.catalog.siteUrl ? get(tenant.catalog.siteUrl) : Promise.resolve({}),
  ]);
  return {
    products: normalizeProducts(rawProducts, tenant.catalog.assetBaseUrl),
    info: normalizeInfo(rawSite),
  };
}

export function normalizeProducts(raw: unknown, assetBaseUrl: string): Product[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.id === "string" && typeof p.name === "string")
    .map((p) => ({
      id: p.id,
      name: p.name,
      category: String(p.category ?? ""),
      granulometrie: p.granulometrie || undefined,
      description: p.description || undefined,
      usages: Array.isArray(p.usages) ? p.usages.map(String) : [],
      price: String(p.price ?? "").trim(),
      unit: String(p.unit || "unité"),
      imageUrl: p.image ? new URL(String(p.image), assetBaseUrl).toString() : undefined,
      available: p.available !== false,
    }));
}

export function normalizeInfo(raw: any): BusinessInfo {
  return {
    phone: raw?.phone,
    email: raw?.email,
    address: raw?.address,
    hours: raw?.hours,
    about: raw?.about,
    faq: Array.isArray(raw?.faq)
      ? raw.faq.filter((f: any) => f?.q && f?.a).map((f: any) => ({ q: String(f.q), a: String(f.a) }))
      : [],
  };
}

/** Rend le catalogue en texte pour le prompt système. L'ordre est stable (cache du prompt). */
export function formatCatalog(catalog: Catalog): string {
  const lines = catalog.products.map((p) => {
    const price = p.price ? `${p.price} FCFA / ${p.unit}` : `sur devis (vendu à la ${p.unit})`;
    const parts = [
      `- ${p.name} [id: ${p.id}]`,
      `  Catégorie : ${p.category}${p.granulometrie ? ` · Granulométrie : ${p.granulometrie}` : ""}`,
      `  Prix : ${price}${p.available ? "" : " · ACTUELLEMENT INDISPONIBLE"}${p.imageUrl ? " · photo disponible" : ""}`,
    ];
    if (p.usages.length) parts.push(`  Usages : ${p.usages.join(", ")}`);
    if (p.description) parts.push(`  ${p.description}`);
    return parts.join("\n");
  });
  return lines.join("\n");
}

export function formatBusinessInfo(info: BusinessInfo): string {
  const lines: string[] = [];
  if (info.about) lines.push(`Présentation : ${info.about}`);
  if (info.address) lines.push(`Adresse : ${info.address}`);
  if (info.hours) lines.push(`Horaires : ${info.hours}`);
  if (info.phone) lines.push(`Téléphone : ${info.phone}`);
  if (info.email) lines.push(`E-mail : ${info.email}`);
  if (info.faq.length) {
    lines.push("Questions fréquentes :");
    for (const f of info.faq) lines.push(`- ${f.q}\n  ${f.a}`);
  }
  return lines.join("\n");
}
