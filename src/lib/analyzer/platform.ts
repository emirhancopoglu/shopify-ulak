import { PLATFORMS, type Platform, type PlatformConfidence, type PlatformEvidence } from "@/db/schema";
import { hasShopifyHeaders, hasShopifyMarkup, mentionsShopifyCdn } from "./storefront";

/**
 * Sitenin yazılım platformunu ana sayfadan tespit eder (F6 Faz 1). Saf fonksiyon: ağ isteği yapmaz.
 *
 * Her platform için sinyaller var; her sinyalin bir ağırlığı var (3 = güçlü, 2 = orta, 1 = zayıf).
 * En yüksek toplam kazanır. Toplam 3+ → yüksek güven, 2 → orta, 1 → düşük, 0 → "unknown".
 * Üst çerçeve (Next.js, Nuxt) puanı 3 veya üstüyse alt çerçeve (React, Vue) elenir: Next.js sayfası da React içerir.
 */

export type PlatformInput = {
  html: string;
  headers: Headers;
  /** Alan adının DNS CNAME kayıtları (varsa). Ör. www.site.com → xyz.myshopify.com */
  cnames?: string[];
};

export type PlatformResult = PlatformEvidence & { platform: Platform };

type Ctx = { html: string; headers: Headers; cnames: string[] };
type Signal = { label: string; weight: number; test: (ctx: Ctx) => boolean };

const inHtml = (re: RegExp) => (ctx: Ctx) => re.test(ctx.html);
const inHeader = (name: string, re: RegExp) => (ctx: Ctx) => re.test(ctx.headers.get(name) ?? "");
const inCname = (re: RegExp) => (ctx: Ctx) => ctx.cnames.some((c) => re.test(c));

const SIGNALS: Record<Exclude<Platform, "unknown">, Signal[]> = {
  shopify: [
    { label: "Shopify tema/JS işareti", weight: 3, test: (c) => hasShopifyMarkup(c.html) },
    { label: "Shopify sunucu başlığı", weight: 2, test: (c) => hasShopifyHeaders(c.headers) },
    { label: "myshopify.com DNS kaydı", weight: 2, test: inCname(/(^|\.)myshopify\.com\.?$/i) },
    { label: "cdn.shopify.com dosyaları", weight: 1, test: (c) => mentionsShopifyCdn(c.html) },
  ],
  nextjs: [
    { label: "/_next/static yolu", weight: 3, test: inHtml(/\/_next\/static\//) },
    { label: "__NEXT_DATA__ verisi", weight: 3, test: inHtml(/__NEXT_DATA__/) },
    { label: "X-Powered-By: Next.js", weight: 3, test: inHeader("x-powered-by", /next\.js/i) },
  ],
  react: [
    { label: "data-reactroot işareti", weight: 2, test: inHtml(/data-reactroot/) },
    { label: "react-dom betiği", weight: 1, test: inHtml(/react-dom(\.min|\.development|\.production)?\.js|react-dom@/i) },
    {
      label: "CRA/Vite React paketi (static/js/main.*.js)",
      weight: 2,
      test: (c) => inHtml(/id=["']root["']/)(c) && inHtml(/static\/js\/main\.[a-f0-9]+(\.chunk)?\.js/)(c),
    },
  ],
  angular: [
    { label: "ng-version özniteliği", weight: 3, test: inHtml(/\sng-version=/) },
    { label: "<app-root> etiketi", weight: 2, test: inHtml(/<app-root[\s>]/) },
    { label: "Angular CLI paketleri (runtime/polyfills)", weight: 2, test: inHtml(/(runtime|polyfills)(\.[a-f0-9]+)?\.js/) },
    { label: "AngularJS ng-app", weight: 2, test: inHtml(/\sng-app[\s=>]/) },
  ],
  vue: [
    { label: "data-v-app işareti", weight: 2, test: inHtml(/data-v-app/) },
    { label: "Vue betiği", weight: 2, test: inHtml(/\/vue(\.runtime)?(\.global)?(\.prod)?(\.min)?\.js|vue@\d/i) },
    { label: "Vue CLI chunk-vendors", weight: 2, test: inHtml(/chunk-vendors/) },
  ],
  nuxt: [
    { label: "__NUXT__ verisi", weight: 3, test: inHtml(/window\.__NUXT__|__NUXT_DATA__/) },
    { label: "/_nuxt/ yolu", weight: 3, test: inHtml(/\/_nuxt\//) },
  ],
  wordpress: [
    { label: "wp-content yolu", weight: 3, test: inHtml(/\/wp-content\//) },
    { label: "wp-includes yolu", weight: 2, test: inHtml(/\/wp-includes\//) },
    { label: "WordPress generator etiketi", weight: 3, test: inHtml(/<meta[^>]*generator[^>]*WordPress/i) },
    { label: "wp-json bağlantısı", weight: 3, test: inHeader("link", /wp-json/) },
  ],
  wix: [
    { label: "Wix statik dosyaları", weight: 3, test: inHtml(/static\.wixstatic\.com|static\.parastorage\.com/) },
    { label: "Wix generator etiketi", weight: 3, test: inHtml(/<meta[^>]*generator[^>]*Wix\.com/i) },
    { label: "wixdns.net DNS kaydı", weight: 3, test: inCname(/wixdns\.net/) },
  ],
  webflow: [
    { label: "data-wf-site/page özniteliği", weight: 3, test: inHtml(/data-wf-(site|page)=/) },
    { label: "Webflow generator etiketi", weight: 3, test: inHtml(/<meta[^>]*generator[^>]*Webflow/i) },
    { label: "Webflow DNS kaydı", weight: 3, test: inCname(/webflow/i) },
  ],
  ticimax: [{ label: "Ticimax izi", weight: 3, test: inHtml(/ticimax/i) }],
  ikas: [{ label: "İkas CDN/alan adı izi", weight: 3, test: inHtml(/myikas\.com|cdn\.myikas|ikas\.io/i) }],
  ideasoft: [{ label: "Ideasoft izi", weight: 3, test: inHtml(/ideasoft/i) }],
};

/**
 * Üst platformlardan biri güçlü (≥3) sinyal verirse alt platformlar elenir.
 * İkas/Ticimax/İdeasoft mağazaları kendi motorlarıyla çalışır; ön yüzde Next.js/React parçaları
 * görünse de bu bir özel Next.js sitesi değildir (örn. cdn.myikas.com üzerinden servis edilen Next chunk'ları).
 */
const SUPPRESSIONS: { parents: Platform[]; children: Platform[] }[] = [
  { parents: ["nextjs"], children: ["react"] },
  { parents: ["nuxt"], children: ["vue"] },
  {
    parents: ["ikas", "ticimax", "ideasoft"],
    children: ["nextjs", "react", "angular", "vue", "nuxt"],
  },
];

const MAX_SIGNALS = 6;

function confidenceFor(score: number): PlatformConfidence {
  if (score >= 3) return "high";
  if (score === 2) return "medium";
  return "low";
}

export function detectPlatform(input: PlatformInput): PlatformResult {
  const ctx: Ctx = {
    html: input.html ?? "",
    headers: input.headers,
    cnames: (input.cnames ?? []).map((c) => c.toLowerCase()),
  };

  const scores = new Map<Platform, { score: number; signals: string[] }>();
  for (const platform of PLATFORMS) {
    if (platform === "unknown") continue;
    const hits = SIGNALS[platform].filter((s) => s.test(ctx));
    scores.set(platform, { score: hits.reduce((n, s) => n + s.weight, 0), signals: hits.map((s) => s.label) });
  }

  // Güçlü üst platform varsa alt platformları ele (eşikler bastırmadan önce, bir kez hesaplanır)
  const strongPlatforms = new Set([...scores].filter(([, v]) => v.score >= 3).map(([p]) => p));
  for (const { parents, children } of SUPPRESSIONS) {
    if (!parents.some((parent) => strongPlatforms.has(parent))) continue;
    for (const child of children) scores.set(child, { score: 0, signals: [] });
  }

  let best: { platform: Platform; score: number; signals: string[] } = { platform: "unknown", score: 0, signals: [] };
  for (const [platform, { score, signals }] of scores) {
    // Eşitlikte PLATFORMS sırasındaki ilk platform kazanır (strict >)
    if (score > best.score) best = { platform, score, signals };
  }

  if (best.score === 0) return { platform: "unknown", confidence: "low", signals: [] };
  return {
    platform: best.platform,
    confidence: confidenceFor(best.score),
    signals: best.signals.slice(0, MAX_SIGNALS),
  };
}
