import * as cheerio from "cheerio";
import type { StoreStatus } from "@/db/schema";
import { cleanEmail, extractEmails, hasMx, rankEmail } from "./emails";
import { describeError, fetchJson, fetchPage, type Page } from "./http";
import { analyzeFindings, type Finding } from "./findings";
import {
  computeTrScore,
  detectApps,
  detectSocials,
  findContactLinks,
  hasShopifyHeaders,
  hasShopifyMarkup,
  isMetaValid,
  mentionsShopifyCdn,
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
  findings: Finding[]; // öncelik sıralı mağaza eksikleri (şifreli mağazalarda boş)
};

const empty = (status: StoreStatus, error: string | null = null): AnalysisResult => ({
  status,
  error,
  finalUrl: null,
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
  if (!isShopify) {
    if (mentionsShopifyCdn(html)) return { ...empty("not_shopify", "Shopify CDN kullanıyor ama mağaza değil"), finalUrl: home.url };
    return { ...empty("not_shopify"), finalUrl: home.url };
  }

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
  const emailMap = new Map<string, { sourceUrl: string }>();
  const collect = (page$: cheerio.CheerioAPI, url: string) => {
    for (const e of extractEmails(page$)) if (!emailMap.has(e)) emailMap.set(e, { sourceUrl: url });
  };
  collect($, home.url);

  const extraPages = [
    ...CONTACT_PATHS.map((p) => `${origin}${p}`),
    ...findContactLinks($, home.url),
  ].filter((u, i, arr) => arr.indexOf(u) === i);

  for (const url of extraPages) {
    // Mağazanın kendi alan adında bir adres bulduysak aramayı bitir.
    if ([...emailMap.keys()].some((e) => rankEmail(e, host) >= 10)) break;
    try {
      const page = await fetchPage(url);
      if (!page.ok || !(page.headers.get("content-type") ?? "").includes("html")) continue;
      collect(cheerio.load(page.body), page.url);
    } catch {
      /* tek sayfa açılmazsa diğerlerine devam */
    }
  }

  // meta.json'da bazen mağaza maili de olur
  const metaEmail = cleanEmail((meta as { email?: string } | null)?.email ?? "");
  if (metaEmail && !emailMap.has(metaEmail)) emailMap.set(metaEmail, { sourceUrl: `${origin}/meta.json` });

  const emails: FoundEmail[] = await Promise.all(
    [...emailMap.entries()].map(async ([email, { sourceUrl }]) => ({
      email,
      sourceUrl,
      mxValid: await hasMx(email.split("@")[1]),
      score: rankEmail(email, host),
    })),
  );
  emails.sort((a, b) => Number(b.mxValid !== false) - Number(a.mxValid !== false) || b.score - a.score);

  // --- Mağaza eksikleri (şifreli mağazada erişim yok, atlanır) ---
  const findings = passwordProtected
    ? []
    : await analyzeFindings({ origin, finalUrl: home.url, $, html, products: productList });

  const language = parseLanguage($, html);
  const country = meta?.country ?? null;
  const currency = meta?.currency ?? null;

  return {
    status: passwordProtected ? "password" : "done",
    error: null,
    finalUrl: home.url,
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
