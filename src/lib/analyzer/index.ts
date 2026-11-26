import * as cheerio from "cheerio";
import type { Platform, PlatformEvidence, StoreStatus } from "@/db/schema";
import { cleanEmail, extractEmails, hasMx, rankEmail } from "./emails";
import { describeError, fetchJson, fetchPage, type Page } from "./http";
import { analyzeFindings, type Finding } from "./findings";
import { detectPlatform } from "./platform";
import {
  computeTrScore,
  detectApps,
  detectSocials,
  findContactLinks,
  hasShopifyHeaders,
  hasShopifyMarkup,
  isMetaValid,
  parseLanguage,
  parseMyshopifyDomain,
  parseTheme,
  summarizeProducts,
  type ShopifyMeta,
  type ShopifyProduct,
} from "./storefront";

export type FoundEmail = { email: string; sourceUrl: string; mxValid: boolean | null; score: number };

export type AnalysisResult = {
  status: StoreStatus;
  error: string | null;
  finalUrl: string | null;
  platform: Platform | null;
  platformEvidence: PlatformEvidence | null;
  myshopifyDomain: string | null;
  brandName: string | null;
  description: string | null;
  country: string | null;
  province: string | null;
  city: string | null;
  currency: string | null;
  language: string | null;
  category: string | null;
  productCount: number | null;
  priceMin: number | null;
  priceMax: number | null;
  lastProductAt: Date | null;
  themeName: string | null;
  apps: string[];
  socials: Record<string, string>;
  trScore: number;
  emails: FoundEmail[]; // puana göre sıralı, ilki birincil
  findings: Finding[]; // öncelik sıralı mağaza eksikleri (yalnızca Shopify, şifreli mağazalarda boş)
};

const empty = (status: StoreStatus, error: string | null = null): AnalysisResult => ({
  status,
  error,
  finalUrl: null,
  platform: null,
  platformEvidence: null,
  myshopifyDomain: null,
  brandName: null,
  description: null,
  country: null,
  province: null,
  city: null,
  currency: null,
  language: null,
  category: null,
  productCount: null,
  priceMin: null,
  priceMax: null,
  lastProductAt: null,
  themeName: null,
  apps: [],
  socials: {},
  trScore: 0,
  emails: [],
  findings: [],
});

/** Mail aramak için ana sayfadan sonra bakılacak standart Shopify sayfaları. */
const CONTACT_PATHS = [
  "/policies/contact-information",
  "/pages/contact",
  "/pages/iletisim",
  "/pages/bize-ulasin",
  "/policies/privacy-policy",
  "/policies/terms-of-service",
];

/** Genel sitelerde iletişim sayfası yolları (Türkçe + İngilizce). */
const GENERAL_CONTACT_PATHS = [
  "/iletisim",
  "/iletisim.html",
  "/contact",
  "/contact.html",
  "/contact-us",
  "/hakkimizda",
  "/about",
  "/about-us",
  "/bize-ulasin",
];

/** Genel sitede en fazla bu kadar ek sayfa çekilir (nazik tarama). */
const MAX_GENERAL_EXTRA_PAGES = 8;

async function openHome(domain: string): Promise<Page> {
  try {
    return await fetchPage(`https://${domain}/`);
  } catch (httpsErr) {
    try {
      return await fetchPage(`http://${domain}/`);
    } catch {
      throw httpsErr;
    }
  }
}

/**
 * Ana sayfa + verilen ek sayfalardan mail adreslerini toplar, sıralar ve MX kontrolü yapar.
 * Mağazanın kendi alan adında bir adres bulunduğunda ek sayfa aramasını bırakır.
 */
async function gatherEmails(opts: {
  $: cheerio.CheerioAPI;
  homeUrl: string;
  host: string;
  extraUrls: string[];
  seed?: { email: string; sourceUrl: string } | null;
}): Promise<FoundEmail[]> {
  const emailMap = new Map<string, { sourceUrl: string }>();
  const collect = (page$: cheerio.CheerioAPI, url: string) => {
    for (const e of extractEmails(page$)) if (!emailMap.has(e)) emailMap.set(e, { sourceUrl: url });
  };
  collect(opts.$, opts.homeUrl);

  for (const url of opts.extraUrls) {
    // Mağazanın kendi alan adında bir adres bulduysak aramayı bitir.
    if ([...emailMap.keys()].some((e) => rankEmail(e, opts.host) >= 10)) break;
    try {
      const page = await fetchPage(url);
      if (!page.ok || !(page.headers.get("content-type") ?? "").includes("html")) continue;
      collect(cheerio.load(page.body), page.url);
    } catch {
      /* tek sayfa açılmazsa diğerlerine devam */
    }
  }

  if (opts.seed && !emailMap.has(opts.seed.email)) emailMap.set(opts.seed.email, { sourceUrl: opts.seed.sourceUrl });

  const emails: FoundEmail[] = await Promise.all(
    [...emailMap.entries()].map(async ([email, { sourceUrl }]) => ({
      email,
      sourceUrl,
      mxValid: await hasMx(email.split("@")[1]),
      score: rankEmail(email, opts.host),
    })),
  );
  emails.sort((a, b) => Number(b.mxValid !== false) - Number(a.mxValid !== false) || b.score - a.score);
  return emails;
}

export async function analyzeStore(domain: string): Promise<AnalysisResult> {
  let home: Page;
  try {
    home = await openHome(domain);
  } catch (err) {
    return empty("unreachable", describeError(err));
  }
  if (home.status >= 500 || (home.status >= 400 && home.status !== 401 && home.status !== 403)) {
    return { ...empty("unreachable", `HTTP ${home.status}`), finalUrl: home.url };
  }

  const finalUrl = new URL(home.url);
  const origin = finalUrl.origin;
  const host = finalUrl.host.replace(/^www\./, "");
  const html = home.body;

  const meta = await fetchJson<ShopifyMeta>(`${origin}/meta.json`);
  const metaOk = isMetaValid(meta);

  // Sadece CDN'den dosya çekmek yetmez (Buy Button kullanan siteler); header, tema işareti veya geçerli meta.json gerekir.
  const isShopify = metaOk || hasShopifyHeaders(home.headers) || hasShopifyMarkup(html);
  if (!isShopify) return analyzeGeneralSite(home, host);

  const $ = cheerio.load(html);
  const passwordProtected = /\/password\/?$/.test(finalUrl.pathname);

  // --- Ürünler ---
  let productStats = summarizeProducts([]);
  let productList: ShopifyProduct[] = [];
  if (!passwordProtected) {
    const data = await fetchJson<{ products?: ShopifyProduct[] }>(`${origin}/products.json?limit=250`);
    productList = data?.products ?? [];
    productStats = summarizeProducts(productList);
  }

  // --- Mail adresleri ---
  const metaEmail = cleanEmail((meta as { email?: string } | null)?.email ?? "");
  const extraUrls = [...CONTACT_PATHS.map((p) => `${origin}${p}`), ...findContactLinks($, home.url)].filter(
    (u, i, arr) => arr.indexOf(u) === i,
  );
  const emails = await gatherEmails({
    $,
    homeUrl: home.url,
    host,
    extraUrls,
    // meta.json'da bazen mağaza maili de olur
    seed: metaEmail ? { email: metaEmail, sourceUrl: `${origin}/meta.json` } : null,
  });

  // --- Mağaza eksikleri (şifreli mağazada erişim yok, atlanır) ---
  const findings = passwordProtected
    ? []
    : await analyzeFindings({ origin, finalUrl: home.url, $, html, products: productList });

  const language = parseLanguage($, html);
  const country = meta?.country ?? null;
  const currency = meta?.currency ?? null;

  // Platform: Shopify kesin; güven, meta.json ya da tema işaretiyle yüksek, yalnız header ile orta.
  const shopifySignals = [
    metaOk ? "meta.json geçerli" : null,
    hasShopifyMarkup(html) ? "Shopify tema/JS işareti" : null,
    hasShopifyHeaders(home.headers) ? "Shopify sunucu başlığı" : null,
  ].filter((s): s is string => s !== null);

  return {
    status: passwordProtected ? "password" : "done",
    error: null,
    finalUrl: home.url,
    platform: "shopify",
    platformEvidence: { confidence: metaOk || hasShopifyMarkup(html) ? "high" : "medium", signals: shopifySignals },
    myshopifyDomain: meta?.myshopify_domain ?? parseMyshopifyDomain(html),
    brandName: meta?.name?.trim() || $('meta[property="og:site_name"]').attr("content")?.trim() || null,
    description: meta?.description?.trim() || null,
    country,
    province: meta?.province ?? null,
    city: meta?.city ?? null,
    currency,
    language,
    category: productStats.category,
    productCount:
      typeof meta?.published_products_count === "number"
        ? meta.published_products_count
        : productStats.sampleSize < 250
          ? productStats.sampleSize || null
          : null,
    priceMin: productStats.priceMin,
    priceMax: productStats.priceMax,
    lastProductAt: productStats.lastProductAt,
    themeName: parseTheme(html),
    apps: detectApps(html),
    socials: detectSocials($),
    trScore: computeTrScore({ country, currency, language, host }),
    emails,
    findings,
  };
}

/**
 * Shopify olmayan site (F6 Faz 2): platform tespiti, iletişim e-postaları, marka ve dil.
 * Shopify'a özgü alanlar (ürün, tema, uygulama, mağaza eksikleri) boş kalır.
 */
async function analyzeGeneralSite(home: Page, host: string): Promise<AnalysisResult> {
  const finalUrl = new URL(home.url);
  const origin = finalUrl.origin;
  const html = home.body;
  const $ = cheerio.load(html);

  const detected = detectPlatform({ html, headers: home.headers });
  // Shopify sinyali buraya kadar gelmişse yalnızca CDN dosyası vardır (Buy Button); mağaza değildir.
  const platform: Platform = detected.platform === "shopify" ? "unknown" : detected.platform;
  const platformEvidence: PlatformEvidence =
    platform === "unknown" ? { confidence: "low", signals: [] } : { confidence: detected.confidence, signals: detected.signals };

  const title = $("title").first().text().split(/\s[|–—-]\s/)[0]?.trim() || null;
  const brandName = $('meta[property="og:site_name"]').attr("content")?.trim() || title;
  const description =
    $('meta[name="description"]').attr("content")?.trim() || $('meta[property="og:description"]').attr("content")?.trim() || null;
  const language = parseLanguage($, html);

  const extraUrls = [...findContactLinks($, home.url), ...GENERAL_CONTACT_PATHS.map((p) => `${origin}${p}`)]
    .filter((u, i, arr) => arr.indexOf(u) === i)
    .slice(0, MAX_GENERAL_EXTRA_PAGES);
  const emails = await gatherEmails({ $, homeUrl: home.url, host, extraUrls });

  return {
    ...empty("done"),
    finalUrl: home.url,
    platform,
    platformEvidence,
    brandName: brandName || null,
    description,
    language,
    socials: detectSocials($),
    trScore: computeTrScore({ language, host }),
    emails,
  };
}
