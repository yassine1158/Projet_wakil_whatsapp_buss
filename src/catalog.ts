import type { BusinessInfo, Catalog, Product, Tenant } from "./types";

type FetchLike = typeof fetch;

/**
 * Charge le catalogue de l'entreprise : les produits saisis dans l'application, ou ceux
 * de son site (format products.json / site.json du site SICAR), mis en cache 5 minutes.
 */
export async function loadCatalog(tenant: Tenant, fetchFn: FetchLike = fetch): Promise<Catalog> {
  const get = async (url: string) => {
    const res = await fetchFn(url, { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit);
    if (!res.ok) throw new Error(`Catalogue indisponible (${res.status}) : ${url}`);
    return res.json();
  };
  const { products, productsUrl, siteUrl, assetBaseUrl } = tenant.catalog;
  const [rawProducts, rawSite] = await Promise.all([
    products ?? (productsUrl ? get(productsUrl) : Promise.resolve([])),
    siteUrl ? get(siteUrl) : Promise.resolve({}),
  ]);
  const info = normalizeInfo(rawSite);
  // Ce qui est saisi dans l'application complète ou remplace les informations du site.
  for (const [k, v] of Object.entries(tenant.info ?? {})) if (v) (info as unknown as Record<string, unknown>)[k] = v;
  return { products: normalizeProducts(rawProducts, assetBaseUrl), info };
}

/** Identifiant stable tiré d'un nom de produit : « Gravier 15/25 » → « gravier-15-25 ». */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function imageUrl(image: unknown, base: string | undefined): string | undefined {
  if (!image) return undefined;
  try {
    return new URL(String(image), base || undefined).toString();
  } catch {
    return undefined; // chemin relatif sans adresse de base : pas de photo
  }
}

export function normalizeProducts(raw: unknown, assetBaseUrl?: string): Product[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const p of raw) {
    if (!p || typeof p.name !== "string" || !p.name.trim()) continue;
    let id = typeof p.id === "string" && p.id ? p.id : slugify(p.name) || "produit";
    for (let n = 2; seen.has(id); n++) id = `${slugify(p.name)}-${n}`;
    seen.add(id);
    out.push({
      id,
      name: p.name.trim(),
      category: String(p.category ?? ""),
      granulometrie: p.granulometrie || undefined,
      description: p.description || undefined,
      usages: Array.isArray(p.usages) ? p.usages.map(String) : [],
      price: String(p.price ?? "").trim(),
      unit: String(p.unit || "unité"),
      imageUrl: imageUrl(p.image, assetBaseUrl),
      available: p.available !== false,
    });
  }
  return out;
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
