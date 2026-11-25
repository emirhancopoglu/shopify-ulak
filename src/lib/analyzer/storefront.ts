import type { CheerioAPI } from "cheerio";

/** Shopify'ın herkese açık /meta.json yanıtı (alanlar mağazaya göre eksik olabilir). */
export type ShopifyMeta = {
  id?: number;
  name?: string;
  description?: string;
  city?: string;
  province?: string;
  country?: string;
  currency?: string;
  domain?: string;
  url?: string;
  myshopify_domain?: string;
  published_products_count?: number;
  published_collections_count?: number;
  ships_to_countries?: string[];
};

export type ShopifyProduct = {
  handle?: string;
  product_type?: string;
  vendor?: string;
  tags?: string[] | string;
  created_at?: string;
  published_at?: string;
  variants?: { price?: string | number }[];
  images?: { alt?: string | null; src?: string }[];
};

export function hasShopifyHeaders(h: Headers): boolean {
  return Boolean(
    h.get("x-shopid") ||
      h.get("x-shopify-stage") ||
      h.get("x-shopify-request-id") ||
      /shopify/i.test(h.get("powered-by") ?? "") ||
      /shopify/i.test(h.get("server-timing") ?? ""),
  );
}

/** Kuvvetli HTML işaretleri: tema veya Shopify JS nesnesi. */
export function hasShopifyMarkup(html: string): boolean {
  return /Shopify\.theme\s*=|window\.Shopify\s*=|Shopify\.shop\s*=|class="shopify-section|id="shopify-section-/i.test(html);
}

/** Zayıf işaret: sadece CDN'den dosya yüklemesi (Buy Button kullanan siteler de yapar). */
export function mentionsShopifyCdn(html: string): boolean {
  return /cdn\.shopify\.com|\/cdn\/shop\//i.test(html);
}

export function isMetaValid(meta: ShopifyMeta | null): meta is ShopifyMeta {
  return Boolean(meta && (meta.myshopify_domain || typeof meta.published_products_count === "number" || meta.id));
}

export function parseMyshopifyDomain(html: string): string | null {
  return html.match(/Shopify\.shop\s*=\s*["']([a-z0-9-]+\.myshopify\.com)["']/i)?.[1]?.toLowerCase() ?? null;
}

export function parseTheme(html: string): string | null {
  const raw = html.match(/Shopify\.theme\s*=\s*(\{[^;]*?\})\s*;/)?.[1];
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { name?: string; schema_name?: string | null };
    return t.schema_name || t.name || null;
  } catch {
    return raw.match(/"schema_name"\s*:\s*"([^"]+)"/)?.[1] ?? raw.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  }
}

export function parseLanguage($: CheerioAPI, html: string): string | null {
  const lang = $("html").attr("lang") || html.match(/Shopify\.locale\s*=\s*["']([a-z-]+)["']/i)?.[1];
  return lang ? lang.slice(0, 2).toLowerCase() : null;
}

/** Sayfada yüklü pazarlama/yorum/destek uygulamaları. */
const APP_SIGNATURES: [string, RegExp][] = [
  ["Klaviyo", /klaviyo\.com|klaviyo\.js/i],
  ["Omnisend", /omnisend/i],
  ["Mailchimp", /chimpstatic\.com|list-manage\.com/i],
  ["Privy", /privy\.com/i],
  ["Judge.me", /judge\.me|judgeme/i],
  ["Yotpo", /yotpo\.com/i],
  ["Loox", /loox\.io/i],
  ["Okendo", /okendo\.io/i],
  ["Stamped", /stamped\.io/i],
  ["Tidio", /tidio\.co|tidiochat/i],
  ["Gorgias", /gorgias\.(chat|io)/i],
  ["Zendesk", /zdassets\.com|zendesk/i],
  ["WhatsApp", /wa\.me\/|api\.whatsapp\.com/i],
  ["ReCharge", /rechargecdn|rechargepayments/i],
  ["PageFly", /pagefly/i],
  ["GemPages", /gempages/i],
  ["Shogun", /getshogun|shogun-frontend/i],
  ["Hotjar", /static\.hotjar\.com/i],
  ["Meta Pixel", /connect\.facebook\.net|fbq\(\s*['"]init/i],
  ["TikTok Pixel", /analytics\.tiktok\.com/i],
  ["Google Analytics", /googletagmanager\.com|gtag\(\s*['"]config/i],
];

export function detectApps(html: string): string[] {
  return APP_SIGNATURES.filter(([, re]) => re.test(html)).map(([name]) => name);
}

const SOCIAL_SIGNATURES: [string, RegExp][] = [
  ["instagram", /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|reel\/|share)[^/?#]+/i],
  ["facebook", /^https?:\/\/(www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\/)[^?#]+/i],
  ["tiktok", /^https?:\/\/(www\.)?tiktok\.com\/@[^/?#]+/i],
  ["youtube", /^https?:\/\/(www\.)?youtube\.com\/(@|c\/|channel\/|user\/)[^?#]+/i],
  ["x", /^https?:\/\/(www\.)?(twitter|x)\.com\/(?!intent|share)[^/?#]+/i],
  ["linkedin", /^https?:\/\/([a-z]+\.)?linkedin\.com\/(company|in)\/[^?#]+/i],
  ["pinterest", /^https?:\/\/([a-z]+\.)?pinterest\.[a-z.]+\/(?!pin\/create)[^/?#]+/i],
  ["whatsapp", /^https?:\/\/(wa\.me|api\.whatsapp\.com)\/.+/i],
];

export function detectSocials($: CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    for (const [name, re] of SOCIAL_SIGNATURES) {
      if (!out[name] && re.test(href)) out[name] = href.split("?")[0];
    }
  });
  return out;
}

/** Ana sayfadaki iletişim/hakkımızda linkleri (mail aramak için). */
export function findContactLinks($: CheerioAPI, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const label = $(el).text().trim().toLowerCase();
    if (!/contact|iletisim|iletişim|bize-ulas|bize ulaş|hakkimizda|hakkımızda|about/i.test(`${href} ${label}`)) return;
    try {
      const u = new URL(href, base);
      if (u.host === base.host) links.add(`${u.origin}${u.pathname}`);
    } catch {
      /* geçersiz link */
    }
  });
  return [...links].slice(0, 4);
}

export type ProductStats = {
  category: string | null;
  priceMin: number | null;
  priceMax: number | null;
  lastProductAt: Date | null;
  sampleSize: number;
};

export function summarizeProducts(products: ShopifyProduct[]): ProductStats {
  const typeCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  let priceMin = Infinity;
  let priceMax = -Infinity;
  let last = 0;

  for (const p of products) {
    const type = p.product_type?.trim();
    if (type) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);

    const tags = Array.isArray(p.tags) ? p.tags : (p.tags ?? "").split(",");
    for (const t of tags.map((x) => x.trim()).filter(Boolean)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);

    for (const v of p.variants ?? []) {
      const price = Number(v.price);
      if (Number.isFinite(price) && price > 0) {
        priceMin = Math.min(priceMin, price);
        priceMax = Math.max(priceMax, price);
      }
    }

    const ts = Date.parse(p.published_at ?? p.created_at ?? "");
    if (Number.isFinite(ts)) last = Math.max(last, ts);
  }

  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    category: top(typeCounts) ?? top(tagCounts),
    priceMin: Number.isFinite(priceMin) ? priceMin : null,
    priceMax: Number.isFinite(priceMax) ? priceMax : null,
    lastProductAt: last ? new Date(last) : null,
    sampleSize: products.length,
  };
}

/** 0-100 arası: mağazanın Türkiye'ye ne kadar odaklı olduğu. */
export function computeTrScore(i: { country?: string | null; currency?: string | null; language?: string | null; host: string }): number {
  let s = 0;
  if (i.country?.toUpperCase() === "TR" || /^t(ü|u)rk(iye|ey)$/i.test(i.country ?? "")) s += 40;
  if (i.currency?.toUpperCase() === "TRY") s += 25;
  if (i.language === "tr") s += 20;
  if (/\.tr$/.test(i.host)) s += 15;
  return s;
}
