/**
 * Mağaza eksikleri (bulgular) testi. Gerçek sitelere istek atmaz; yerel bir HTTP sunucusu kullanır.
 * Çalıştırma: npm run test:findings
 */
import http from "node:http";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import {
  altFinding,
  analyzeFindings,
  brokenLinksFinding,
  contactFinding,
  findBrokenLinks,
  internalNavLinks,
  reviewFinding,
  sortFindings,
  themeFinding,
  viewportFinding,
} from "../src/lib/analyzer/findings";
import type { ShopifyProduct } from "../src/lib/analyzer/storefront";

type SiteOpts = { theme: string; apps: string; withAlt: boolean; contactPage: boolean; brokenPage: boolean };

function makeSite(opts: SiteOpts) {
  const home = `<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<script>Shopify.theme = {"name":"${opts.theme}","schema_name":"${opts.theme}"};</script></head>
<body><div id="shopify-section-header" class="shopify-section"><header><nav>
<a href="/collections/all">Ürünler</a>
<a href="/pages/kayip">Kayıp sayfa</a>
<a href="/cart">Sepet</a>
<a href="https://instagram.com/x">Instagram</a>
</nav></header></div></body></html>`;
  const product = `<html><body><div id="shopify-section-product">${opts.apps}</div></body></html>`;
  const products: ShopifyProduct[] = Array.from({ length: 6 }, (_, i) => ({
    handle: `urun-${i + 1}`,
    images: [{ src: "x.jpg", alt: opts.withAlt ? `Ürün ${i + 1}` : null }],
  }));
  const pages: Record<string, { status: number; type: string; body: string }> = {
    "/": { status: 200, type: "text/html", body: home },
    "/collections/all": { status: 200, type: "text/html", body: "<html><body>Ürünler</body></html>" },
    "/pages/kayip": opts.brokenPage ? { status: 404, type: "text/html", body: "bulunamadı" } : { status: 200, type: "text/html", body: "ok" },
    "/pages/contact": opts.contactPage ? { status: 200, type: "text/html", body: "<html><body>İletişim</body></html>" } : { status: 404, type: "text/html", body: "yok" },
    "/products.json": { status: 200, type: "application/json", body: JSON.stringify({ products }) },
    "/products/urun-1": { status: 200, type: "text/html", body: product },
  };
  return pages;
}

async function serve(pages: ReturnType<typeof makeSite>) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = pages[path] ?? { status: 404, type: "text/html", body: "yok" };
    res.writeHead(page.status, { "content-type": page.type });
    res.end(page.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function main() {
  // --- Saf kurallar
  assert.equal(themeFinding("Debut", true)?.key, "old_theme");
  assert.match(themeFinding("Debut", true)!.sentence, /"Debut" teması/);
  assert.equal(themeFinding("Dawn", true), null, "Dawn eski sayılmamalı");
  assert.equal(themeFinding("Dawn", false)?.key, "old_theme", "bölüm yoksa eski yapı bulgusu");
  assert.equal(themeFinding(null, false), null, "tema bilinmiyorsa bulgu yok");
  assert.equal(reviewFinding(["Judge.me"], ""), null);
  assert.equal(reviewFinding(["Klaviyo"], "<html></html>")?.key, "no_reviews");
  assert.equal(reviewFinding([], '<script type="application/ld+json">{"aggregateRating":{"ratingValue":"4.8"}}</script>'), null, "yapısal yorum verisi varsa bulgu yok");
  assert.equal(reviewFinding([], '<div class="product-reviews__list"></div>'), null, "review sınıfı varsa bulgu yok");
  assert.equal(contactFinding(true), null);
  assert.equal(contactFinding(false)?.key, "no_contact");
  assert.equal(viewportFinding(cheerio.load('<meta name="viewport" content="x">')), null);
  assert.equal(viewportFinding(cheerio.load("<html></html>"))?.key, "no_mobile_meta");

  // alt metni: "alt" alanı hiç yoksa bilinmiyor → bulgu yok (yanlış suçlama olmasın)
  assert.equal(altFinding([{ images: [{ src: "a" }, { src: "b" }, { src: "c" }, { src: "d" }, { src: "e" }] }]), null);
  assert.equal(altFinding(Array.from({ length: 6 }, () => ({ images: [{ alt: null }] })))?.key, "missing_alt");
  assert.equal(altFinding(Array.from({ length: 6 }, (_, i) => ({ images: [{ alt: `ürün ${i}` }] }))), null);
  assert.equal(altFinding(Array.from({ length: 3 }, () => ({ images: [{ alt: null }] }))), null, "örnek az ise bulgu yok");

  // Menü bağlantıları: aynı site, sepet/hesap yok, dış bağlantı yok
  const $ = cheerio.load(`<header><nav><a href="/collections/all">a</a><a href="/cart">c</a><a href="https://x.com/">x</a><a href="/pages/kayip?x=1">k</a><a href="#">h</a></nav></header>`);
  assert.deepEqual(internalNavLinks($, "https://shop.com/"), ["https://shop.com/collections/all", "https://shop.com/pages/kayip"]);

  // Sıralama: kırık link > eski tema > yorum > alt > iletişim > viewport
  const sorted = sortFindings([
    viewportFinding(cheerio.load("<html></html>")),
    contactFinding(false),
    altFinding(Array.from({ length: 6 }, () => ({ images: [{ alt: null }] }))),
    reviewFinding([], "<html></html>"),
    themeFinding("Debut", true),
    brokenLinksFinding(["https://shop.com/pages/x"]),
  ]);
  assert.deepEqual(sorted.map((f) => f.key), ["broken_links", "old_theme", "no_reviews", "missing_alt", "no_contact", "no_mobile_meta"]);

  // --- Yerel site: kırık link ölçümü (404 kırık, 200 değil)
  const eski = makeSite({ theme: "Debut", apps: "", withAlt: false, contactPage: false, brokenPage: true });
  const srvEski = await serve(eski);
  try {
    const broken = await findBrokenLinks([`${srvEski.origin}/collections/all`, `${srvEski.origin}/pages/kayip`]);
    assert.deepEqual(broken, [`${srvEski.origin}/pages/kayip`]);
    const findings = await analyzeFindings({
      origin: srvEski.origin,
      finalUrl: `${srvEski.origin}/`,
      $: cheerio.load(eski["/"].body),
      html: eski["/"].body,
      products: Array.from({ length: 6 }, (_, i) => ({ handle: `urun-${i + 1}`, images: [{ alt: null }] })),
    });
    const keys = findings.map((f) => f.key);
    assert.deepEqual(keys, ["broken_links", "old_theme", "no_reviews", "missing_alt", "no_contact"], `eski site bulguları: ${keys}`);
    console.log("eski site bulguları:", findings.map((f) => `${f.key}: ${f.label}`).join(" | "));
    // E-posta cümleleri Türkçe ve bağlantısız olmalı
    for (const f of findings) assert.doesNotMatch(f.sentence, /https?:\/\//, `${f.key} cümlesinde bağlantı olmamalı`);
  } finally {
    await srvEski.close();
  }

  // --- Yerel site: modern, yorumlu, alt metinli, iletişim sayfalı → bulgu yok
  const iyi = makeSite({ theme: "Dawn", apps: '<script src="https://cdn.judge.me/widget.js"></script>', withAlt: true, contactPage: true, brokenPage: false });
  const srvIyi = await serve(iyi);
  try {
    const findings = await analyzeFindings({
      origin: srvIyi.origin,
      finalUrl: `${srvIyi.origin}/`,
      $: cheerio.load(iyi["/"].body),
      html: iyi["/"].body,
      products: Array.from({ length: 6 }, (_, i) => ({ handle: `urun-${i + 1}`, images: [{ alt: `ürün ${i}` }] })),
    });
    assert.deepEqual(findings, [], `iyi sitede bulgu olmamalı: ${findings.map((f) => f.key)}`);
    console.log("iyi site: bulgu yok");
  } finally {
    await srvIyi.close();
  }

  console.log("\n✓ mağaza eksikleri kontrolleri geçti");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
