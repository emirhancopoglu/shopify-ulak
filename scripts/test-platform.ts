/**
 * Platform tespiti testi (F6 Faz 1). Ağ yok; gerçeğe yakın HTML parçaları (fixture) kullanır.
 * Çalıştırma: npm run test:platform
 */
import assert from "node:assert/strict";
import { detectPlatform, type PlatformInput } from "../src/lib/analyzer/platform";
import { cleanEmail } from "../src/lib/analyzer/emails";
import type { Platform, PlatformConfidence } from "../src/db/schema";

type Case = {
  name: string;
  html: string;
  headers?: Record<string, string>;
  cnames?: string[];
  expect: Platform;
  minConfidence?: PlatformConfidence;
};

const RANK: Record<PlatformConfidence, number> = { low: 1, medium: 2, high: 3 };

const cases: Case[] = [
  {
    name: "Next.js (Pages/App Router HTML)",
    html: `<!doctype html><html><head><script src="/_next/static/chunks/main-abc.js" async></script></head>
<body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>`,
    expect: "nextjs",
    minConfidence: "high",
  },
  {
    name: "Next.js sadece X-Powered-By başlığıyla",
    html: `<html><body><div>içerik</div></body></html>`,
    headers: { "x-powered-by": "Next.js" },
    expect: "nextjs",
    minConfidence: "high",
  },
  {
    name: "React CRA (data-reactroot yok, bundle adı var)",
    html: `<!doctype html><html><body><div id="root"></div><script src="/static/js/main.3f1c2a.chunk.js"></script></body></html>`,
    expect: "react",
    minConfidence: "medium",
  },
  {
    name: "React eski SSR (data-reactroot)",
    html: `<html><body><div data-reactroot="" class="app">x</div></body></html>`,
    expect: "react",
    minConfidence: "medium",
  },
  {
    name: "Next.js sayfası react-dom da içerir: Next kazanmalı, React elenmeli",
    html: `<html><body><div id="__next" data-reactroot=""></div>
<script src="/_next/static/chunks/react-dom.min.js"></script>
<script src="/_next/static/chunks/main.js"></script></body></html>`,
    expect: "nextjs",
  },
  {
    name: "Angular (ng-version + app-root)",
    html: `<!doctype html><html><body><app-root ng-version="17.3.0"></app-root>
<script src="runtime.a1b2c3d4.js" type="module"></script><script src="main.e5f6a7b8.js" type="module"></script></body></html>`,
    expect: "angular",
    minConfidence: "high",
  },
  {
    name: "AngularJS (ng-app)",
    html: `<html ng-app="shop"><body><div ng-controller="Main"></div></body></html>`,
    expect: "angular",
    minConfidence: "medium",
  },
  {
    name: "Vue (data-v-app, vue.js betiği)",
    html: `<html><body><div id="app" data-v-app=""></div><script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script></body></html>`,
    expect: "vue",
    minConfidence: "medium",
  },
  {
    name: "Nuxt: data-v-app olsa da Vue değil Nuxt",
    html: `<html><body><div id="__nuxt" data-v-app=""></div><script>window.__NUXT__={}</script>
<script src="/_nuxt/entry.js"></script></body></html>`,
    expect: "nuxt",
    minConfidence: "high",
  },
  {
    name: "WordPress (wp-content + generator)",
    html: `<html><head><meta name="generator" content="WordPress 6.5" />
<link rel="stylesheet" href="/wp-content/themes/x/style.css"></head><body></body></html>`,
    expect: "wordpress",
    minConfidence: "high",
  },
  {
    name: "WordPress sadece wp-json bağlantı başlığıyla",
    html: `<html><body>merhaba</body></html>`,
    headers: { link: '<https://ornek.com/wp-json/>; rel="https://api.w.org/"' },
    expect: "wordpress",
    minConfidence: "high",
  },
  {
    name: "Wix",
    html: `<html><head><meta name="generator" content="Wix.com Website Builder"/></head>
<body><img src="https://static.wixstatic.com/media/a.jpg"></body></html>`,
    expect: "wix",
    minConfidence: "high",
  },
  {
    name: "Webflow",
    html: `<html data-wf-site="abc" data-wf-page="def"><head><meta content="Webflow" name="generator"></head><body></body></html>`,
    expect: "webflow",
    minConfidence: "high",
  },
  {
    name: "Shopify (tema işareti)",
    html: `<html><head><script>window.Shopify = {"theme":{}};Shopify.theme = {"name":"dawn"};</script></head>
<body><div id="shopify-section-header" class="shopify-section"></div></body></html>`,
    expect: "shopify",
    minConfidence: "high",
  },
  {
    name: "Headless Shopify: Next.js ön yüz + Shopify DNS → Next.js kazanır",
    html: `<html><body><script src="/_next/static/chunks/app.js"></script><script id="__NEXT_DATA__"></script></body></html>`,
    cnames: ["shops.myshopify.com"],
    expect: "nextjs",
  },
  {
    name: "Ticimax (türk e-ticaret)",
    html: `<html><body><a href="https://www.ticimax.com">E-ticaret altyapısı</a></body></html>`,
    expect: "ticimax",
    minConfidence: "high",
  },
  {
    name: "İkas",
    html: `<html><body><script src="https://cdn.myikas.com/theme.js"></script></body></html>`,
    expect: "ikas",
    minConfidence: "high",
  },
  {
    name: "İkas üzerinde Next.js chunk'ları → ikas (Next.js bastırılır)",
    html: `<html><body><script src="/_next/static/chunks/main.js"></script><script src="https://cdn.myikas.com/app.js"></script></body></html>`,
    expect: "ikas",
    minConfidence: "high",
  },
  {
    name: "Düz statik HTML: bilinmiyor",
    html: `<!doctype html><html lang="tr"><head><title>Ahmet Usta Tesisat</title></head><body><h1>Merhaba</h1><p>İletişim: info@ornek.com</p></body></html>`,
    expect: "unknown",
  },
  {
    name: "Boş sayfa",
    html: "",
    expect: "unknown",
  },
];

let failed = 0;
for (const c of cases) {
  const input: PlatformInput = { html: c.html, headers: new Headers(c.headers ?? {}), cnames: c.cnames };
  const result = detectPlatform(input);
  try {
    assert.equal(result.platform, c.expect, `platform`);
    if (c.minConfidence) {
      assert.ok(RANK[result.confidence] >= RANK[c.minConfidence], `güven ${result.confidence} < ${c.minConfidence}`);
    }
    console.log(`✔ ${c.name} → ${result.platform} (${result.confidence})`);
  } catch (err) {
    failed++;
    console.log(`✘ ${c.name} → ${result.platform} (${result.confidence}) [${result.signals.join(", ")}]`);
    console.log(`  ${(err as Error).message}`);
  }
}

// Dayanaklar boş olmamalı (unknown hariç)
for (const c of cases.filter((x) => x.expect !== "unknown")) {
  const r = detectPlatform({ html: c.html, headers: new Headers(c.headers ?? {}), cnames: c.cnames });
  assert.ok(r.signals.length > 0, `${c.name}: dayanak listesi boş`);
}

// E-posta filtresi: satış dışı adresler (KVKK, gizlilik, İK…) aday listesinde olmamalı
assert.equal(cleanEmail("kvkk@atayatirim.com.tr"), null, "kvkk adresi reddedilmeli");
assert.equal(cleanEmail("gizlilik@ornek.com.tr"), null, "gizlilik adresi reddedilmeli");
assert.equal(cleanEmail("ik@ornek.com.tr"), null, "İK adresi reddedilmeli");
assert.equal(cleanEmail("info@ornek.com.tr"), "info@ornek.com.tr", "info adresi kabul edilmeli");

console.log(failed === 0 ? `\nTümü geçti (${cases.length} durum).` : `\n${failed} durum başarısız.`);
if (failed > 0) process.exit(1);
