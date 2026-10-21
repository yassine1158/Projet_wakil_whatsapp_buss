import type { BusinessInfo, Catalog, Product, RawProduct, Tenant } from "./types";

type FetchLike = typeof fetch;

/**
 * Charge le catalogue de l'entreprise : les produits saisis dans l'application, ou ceux
 * de son site, mis en cache 5 minutes. Deux formats de site sont lus :
 * - products.json / site.json (site SICAR) ;
 * - data/content.js du site SANA (« window.SANA_CONTENT = {…} ») : produits et informations
 *   dans un seul fichier, celui que publie l'administration du site.
 */
export async function loadCatalog(tenant: Tenant, fetchFn: FetchLike = fetch): Promise<Catalog> {
  const get = async (url: string) => {
    const res = await fetchFn(url, { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit);
    if (!res.ok) throw new Error(`Catalogue indisponible (${res.status}) : ${url}`);
    return parseDocument(await res.text(), url);
  };
  const { products, productsUrl, siteUrl, assetBaseUrl } = tenant.catalog;
  let [rawProducts, rawSite] = await Promise.all([
    products ?? (productsUrl ? get(productsUrl) : Promise.resolve([])),
    siteUrl ? get(siteUrl) : Promise.resolve(undefined),
  ]);
  if (isSiteContent(rawProducts)) {
    rawSite ??= siteContentInfo(rawProducts);
    rawProducts = siteContentProducts(rawProducts);
  }
  const info = normalizeInfo(rawSite ?? {});
  // Ce qui est saisi dans l'application complète ou remplace les informations du site.
  for (const [k, v] of Object.entries(tenant.info ?? {})) if (v) (info as unknown as Record<string, unknown>)[k] = v;
  return { products: normalizeProducts(rawProducts, assetBaseUrl), info };
}

/** JSON, ou fichier JavaScript de la forme « window.NOM = {…}; ». */
export function parseDocument(text: string, url = ""): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* format inconnu : erreur ci-dessous */
      }
    }
    throw new Error(`Catalogue illisible : ${url}`);
  }
}

// ---------- Contenu d'un site au format SANA (data/content.js) ----------

type Offer = { id?: string; title?: string; usage?: string; desc?: string; items?: string[]; price?: string; status?: string; visible?: boolean };

function isSiteContent(raw: unknown): raw is Record<string, any> {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && "company" in raw;
}

const sentence = (s: string) => (/[.!?:]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const describe = (o: Offer, extra: string[] = []) =>
  [o.usage, o.desc, ...extra, ...(o.items ?? [])].filter((x): x is string => !!x && !!x.trim()).map(sentence).join(" ");
const shown = (o: Offer | undefined): o is Offer => !!o && o.visible !== false && !!o.title?.trim();

/** Produits d'un contenu de site SANA ; « bientôt » = indisponible pour le moment. */
export function siteContentProducts(c: Record<string, any>): RawProduct[] {
  const out: RawProduct[] = [];
  const add = (o: Offer, id: string, category: string, unit: string, extra?: string[]) =>
    out.push({ id, name: o.title!.trim(), category, description: describe(o, extra), price: String(o.price ?? "").trim(), unit, available: o.status !== "soon" });
  if (shown(c.hatching)) add(c.hatching, "oeufs-a-couver", "Œufs", "œuf");
  for (const o of (c.chickens?.offers ?? []) as Offer[]) {
    if (!shown(o)) continue;
    const id = o.id || o.title!;
    add(o, id, "Volailles", /poussin/i.test(`${o.id} ${o.title}`) ? "poussin" : "sujet");
  }
  if (shown(c.eggs)) add(c.eggs, "oeufs-frais", "Œufs", "plateau");
  if (shown(c.feed)) {
    const species = ((c.species ?? []) as { name?: string }[]).map((s) => s.name).filter(Boolean);
    add(c.feed, "aliments", "Aliments", "sac", species.length ? [`Pour : ${species.join(", ")}`] : []);
  }
  return out;
}

/** Informations de l'entreprise d'un contenu de site SANA, au format de site.json. */
export function siteContentInfo(c: Record<string, any>) {
  const co = c.company ?? {};
  const about = [c.about?.title, ...(c.about?.paragraphs ?? [])].filter(Boolean).map(String).join(" ");
  return {
    phone: co.phone,
    email: co.email,
    address: co.address,
    hours: co.hours,
    about: [co.fullName ? `${co.name ?? ""} (${co.fullName}).` : "", about].join(" ").trim() || undefined,
    faq: c.faq,
  };
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
    // Prix en chiffres (« 25000 ») ou déjà rédigé sur le site (« 650 FCFA par poussin »)
    const price = !p.price ? `sur devis (unité de vente : ${p.unit})` : /[a-z]/i.test(p.price) ? p.price : `${p.price} FCFA / ${p.unit}`;
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
