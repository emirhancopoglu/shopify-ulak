/**
 * Genel site analizi testi (F6 Faz 2). Gerçek sitelere istek atmaz; yerel bir HTTP sunucusu kullanır.
 * Çalıştırma: npm run test:site
 */
import http from "node:http";
import assert from "node:assert/strict";
import { analyzeStore, type AnalysisResult } from "../src/lib/analyzer";

type Page = { status?: number; type?: string; body: string };
type Routes = Record<string, Page>;

async function serve(routes: Routes) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = routes[path] ?? { status: 404, body: "yok" };
    res.writeHead(page.status ?? 200, { "content-type": page.type ?? "text/html; charset=utf-8" });
    res.end(page.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    // Alan adı gibi verilir; analyzer önce https, sonra http dener
    domain: `127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function run(name: string, routes: Routes, check: (r: AnalysisResult, domain: string) => void) {
  const site = await serve(routes);
  try {
    const result = await analyzeStore(site.domain);
    check(result, site.domain);
    console.log(`✔ ${name} → ${result.status}, ${result.platform} (${result.platformEvidence?.confidence ?? "-"})`);
    return true;
  } catch (err) {
    console.log(`✘ ${name}`);
    console.log(`  ${(err as Error).message}`);
    return false;
  } finally {
    await site.close();
  }
}

const nextHome = `<!doctype html><html lang="tr"><head><title>Örnek Lojistik | Anasayfa</title>
<meta name="description" content="Lojistik çözümleri">
<script src="/_next/static/chunks/main.js"></script></head>
<body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script>
<footer><a href="mailto:info@ornek-lojistik.test">Bize yazın</a> <a href="/iletisim">İletişim</a></footer></body></html>`;

const angularHome = `<!doctype html><html><head><title>Firma | Ana Sayfa</title></head>
<body><app-root ng-version="17.0.0"></app-root><script src="runtime.abc12345.js" type="module"></script></body></html>`;

const shopifyHome = `<!doctype html><html lang="tr"><head>
<script>Shopify.theme = {"name":"dawn","schema_name":"Dawn"};</script></head>
<body><div id="shopify-section-header" class="shopify-section"></div></body></html>`;

const plainHome = `<!doctype html><html lang="tr"><head><title>Ahmet Usta Tesisat</title></head>
<body><h1>Merhaba</h1><p>Bize yazın: iletisim@ahmetusta-test.test</p></body></html>`;

const cdnOnlyHome = `<!doctype html><html><head></head><body><p>Mağazamız</p>
<script src="https://cdn.shopify.com/s/files/1/buy-button.js"></script></body></html>`;

async function main() {
  let failed = 0;

  const results = [
    await run(
      "Next.js genel site: platform, e-posta (iletişim sayfasından), marka, dil, TR skoru",
      {
        "/": { body: nextHome },
        "/iletisim": { body: "<html><body><p>Satış: satis@ornek-lojistik.test</p></body></html>" },
      },
      (r) => {
        assert.equal(r.status, "done");
        assert.equal(r.platform, "nextjs");
        assert.equal(r.brandName, "Örnek Lojistik");
        assert.equal(r.description, "Lojistik çözümleri");
        assert.equal(r.language, "tr");
        assert.ok(r.trScore >= 20, `trScore ${r.trScore}`);
        assert.equal(r.productCount, null);
        assert.equal(r.myshopifyDomain, null);
        assert.deepEqual(r.findings, []);
        const emails = r.emails.map((e) => e.email);
        assert.ok(emails.includes("info@ornek-lojistik.test"), `emails: ${emails}`);
        const sales = r.emails.find((e) => e.email === "satis@ornek-lojistik.test");
        assert.ok(sales?.sourceUrl.endsWith("/iletisim"), `kaynak: ${sales?.sourceUrl}`);
      },
    ),
    await run(
      "Angular: e-posta yalnızca /contact sayfasında",
      {
        "/": { body: angularHome },
        "/contact": { body: "<html><body>Destek: destek@firma-test.test</body></html>" },
      },
      (r) => {
        assert.equal(r.status, "done");
        assert.equal(r.platform, "angular");
        assert.equal(r.platformEvidence?.confidence, "high");
        const found = r.emails.find((e) => e.email === "destek@firma-test.test");
        assert.ok(found?.sourceUrl.endsWith("/contact"), `kaynak: ${found?.sourceUrl}`);
      },
    ),
    await run(
      "Shopify mağazası: platform shopify, ürün sayısı meta.json'dan, TR skoru",
      {
        "/": { body: shopifyHome },
        "/meta.json": {
          type: "application/json",
          body: JSON.stringify({ id: 1, name: "Test Mağaza", myshopify_domain: "test-magaza.myshopify.com", published_products_count: 42, country: "TR", currency: "TRY" }),
        },
        "/products.json": { type: "application/json", body: JSON.stringify({ products: [] }) },
      },
      (r) => {
        assert.equal(r.status, "done");
        assert.equal(r.platform, "shopify");
        assert.equal(r.platformEvidence?.confidence, "high");
        assert.equal(r.productCount, 42);
        assert.equal(r.themeName, "Dawn");
        assert.equal(r.myshopifyDomain, "test-magaza.myshopify.com");
        assert.ok(r.trScore >= 65, `trScore ${r.trScore}`);
      },
    ),
    await run(
      "Düz statik HTML: platform unknown, artık not_shopify değil",
      { "/": { body: plainHome } },
      (r) => {
        assert.equal(r.status, "done");
        assert.equal(r.platform, "unknown");
        assert.ok(r.emails.some((e) => e.email === "iletisim@ahmetusta-test.test"));
      },
    ),
    await run(
      "Yalnızca cdn.shopify.com dosyası: Shopify sayılmaz, platform unknown",
      { "/": { body: cdnOnlyHome } },
      (r) => {
        assert.equal(r.status, "done");
        assert.equal(r.platform, "unknown");
        assert.equal(r.myshopifyDomain, null);
      },
    ),
  ];

  // Erişilemeyen site: kapalı bir port
  try {
    const r = await analyzeStore("127.0.0.1:1");
    assert.equal(r.status, "unreachable");
    assert.equal(r.platform, null);
    console.log(`✔ Erişilemeyen port → ${r.status} (${r.error})`);
  } catch (err) {
    failed++;
    console.log(`✘ Erişilemeyen port: ${(err as Error).message}`);
  }

  failed += results.filter((ok) => !ok).length;
  console.log(failed === 0 ? "\nTümü geçti." : `\n${failed} durum başarısız.`);
  if (failed > 0) process.exit(1);
}

main();
