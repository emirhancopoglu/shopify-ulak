/**
 * Mağaza tablosu tür/platform filtresi testi (F6 Faz 4). Ağ yok, ayrı test DB'si kullanır:
 *   npm run test:filters
 *
 * Kontrol edilenler: Shopify / Genel tür kuralı (eski boş-platform kayıtları dahil), platform filtresi,
 * istatistikler, facet sayıları, URL gidiş-dönüşü, CSV sütunları ve TS ile SQL kural eşitliği.
 */
import fs from "node:fs";
import assert from "node:assert/strict";

process.env.DB_FILE = "data/test-filters.db";

async function main() {
  for (const f of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_FILE}${f}`, { force: true });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { db, DB_PATH } = await import("../src/db");
  const { stores } = await import("../src/db/schema");
  const { queryStores, queryStoreIds, storeFacets, storeStats } = await import("../src/lib/stores");
  const { DEFAULT_FILTERS, parseFilters, serializeFilters, activeFilterCount } = await import("../src/lib/store-filters");
  const { effectivePlatform, siteKind } = await import("../src/lib/platform-labels");
  type StoreFilters = import("../src/lib/store-filters").StoreFilters;
  type Platform = import("../src/db/schema").Platform;
  type StoreStatus = import("../src/db/schema").StoreStatus;

  assert(DB_PATH.includes("test-filters"), "Bu test sadece ayrı test DB'si ile çalışır");
  migrate(db, { migrationsFolder: "./drizzle" });

  // domain → [durum, kaynak, platform, beklenen tür, beklenen etkin platform]
  type Fixture = [domain: string, status: StoreStatus, source: string, platform: Platform | null, kind: "shopify" | "general", effective: Platform | null];
  const fixtures: Fixture[] = [
    ["a.com", "done", "ccdomains", "shopify", "shopify", "shopify"],
    ["b.com", "done", "ccdomains", null, "shopify", "shopify"], // eski kayıt: F6'dan önce analiz edilmiş Shopify
    ["c.com", "password", "ccdomains", null, "shopify", "shopify"], // eski şifreli mağaza
    ["d.com", "pending", "ccdomains", null, "shopify", null], // Shopify keşfinden, henüz analiz edilmedi
    ["e.com", "unreachable", "ccdomains", null, "shopify", null],
    ["f.com", "not_shopify", "ccdomains", null, "general", null], // eski not_shopify satırı
    ["g.com", "done", "general_ccdomains", "nextjs", "general", "nextjs"],
    ["h.com", "done", "general_tranco", "wordpress", "general", "wordpress"],
    ["i.com", "pending", "general_ccdomains", null, "general", null], // genel keşiften, henüz analiz edilmedi
    ["j.com", "done", "manual", "unknown", "general", "unknown"],
    ["k.com", "done", "manual", "ikas", "general", "ikas"],
  ];
  for (const [domain, status, source, platform] of fixtures) {
    db.insert(stores).values({ domain, status, source, platform, brandName: domain.replace(".com", "").toUpperCase() }).run();
  }

  const all = (patch: Partial<StoreFilters> = {}) => ({ ...DEFAULT_FILTERS, pageSize: 200, ...patch });
  const domains = (patch: Partial<StoreFilters>) =>
    queryStores(all(patch))
      .rows.map((r) => r.domain)
      .sort();

  // 1) Tür filtresi
  assert.deepEqual(domains({ kind: "shopify" }), ["a.com", "b.com", "c.com", "d.com", "e.com"], "Shopify türü (eski boş-platform kayıtlar dahil)");
  assert.deepEqual(domains({ kind: "genel" }), ["f.com", "g.com", "h.com", "i.com", "j.com", "k.com"], "Genel tür");
  assert.equal(queryStores(all()).total, fixtures.length, "filtresiz hepsi");
  assert.equal(queryStores(all({ kind: "shopify" })).total + queryStores(all({ kind: "genel" })).total, fixtures.length, "iki tür birbirini tamamlar");

  // 2) Platform filtresi (eski Shopify kayıtları "shopify" sayılır; analizi bitmemiş olanlar platformsuzdur)
  assert.deepEqual(domains({ platform: ["shopify"] }), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(domains({ platform: ["nextjs", "wordpress"] }), ["g.com", "h.com"]);
  assert.deepEqual(domains({ platform: ["unknown"] }), ["j.com"]);
  assert.deepEqual(domains({ kind: "genel", platform: ["shopify"] }), [], "Genel + Shopify platformu boş döner");
  assert.deepEqual(domains({ kind: "shopify", platform: ["nextjs"] }), []);
  assert.deepEqual(domains({ kind: "genel", platform: ["ikas", "unknown"] }), ["j.com", "k.com"]);

  // 3) Diğer filtrelerle birleşim + toplu hedef (kampanya/yeniden analiz aynı filtreyi kullanır)
  assert.deepEqual(domains({ kind: "genel", status: ["done"] }), ["g.com", "h.com", "j.com", "k.com"]);
  const ids = queryStoreIds(all({ kind: "genel", platform: ["nextjs", "wordpress"] }));
  assert.equal(ids.length, 2, "queryStoreIds filtreyle uyumlu");

  // 4) İstatistikler ve facet'ler
  const stats = storeStats();
  assert.equal(stats.total, fixtures.length);
  assert.equal(stats.shopify, 3, "Shopify istatistiği: analizi biten (a, b, c)");
  assert.equal(stats.general, 4, "Genel site istatistiği: analizi biten (g, h, j, k)");
  const facets = storeFacets();
  assert.deepEqual(facets.kind, { shopify: 5, general: 6 });
  const byPlatform = Object.fromEntries(facets.platform.map((f) => [f.value, f.count]));
  assert.deepEqual(byPlatform, { shopify: 3, nextjs: 1, wordpress: 1, unknown: 1, ikas: 1 });

  // 5) TS kuralı (siteKind/effectivePlatform) SQL kuralıyla aynı sonucu vermeli
  const shopifySet = new Set(domains({ kind: "shopify" }));
  const effectiveByDomain = new Map<string, string | null>();
  for (const p of ["shopify", "nextjs", "wordpress", "unknown", "ikas"] as Platform[]) {
    for (const d of domains({ platform: [p] })) effectiveByDomain.set(d, p);
  }
  for (const [domain, status, source, platform, kind, effective] of fixtures) {
    const input = { platform, status, source };
    assert.equal(siteKind(input), kind, `${domain}: siteKind`);
    assert.equal(effectivePlatform(input), effective, `${domain}: effectivePlatform`);
    assert.equal(shopifySet.has(domain), siteKind(input) === "shopify", `${domain}: TS ve SQL tür kuralı aynı`);
    assert.equal(effectiveByDomain.get(domain) ?? null, effectivePlatform(input), `${domain}: TS ve SQL etkin platform aynı`);
  }

  // 6) URL gidiş-dönüşü ve geçersiz değerler
  const filters: StoreFilters = { ...DEFAULT_FILTERS, kind: "genel", platform: ["nextjs", "wordpress"] };
  const qs = serializeFilters(filters).toString();
  assert.equal(qs, "tip=genel&platform=nextjs%2Cwordpress");
  const parsed = parseFilters(new URLSearchParams(qs));
  assert.equal(parsed.kind, "genel");
  assert.deepEqual(parsed.platform, ["nextjs", "wordpress"]);
  const bad = parseFilters(new URLSearchParams("tip=x&platform=bogus,nextjs"));
  assert.equal(bad.kind, undefined, "geçersiz tür yok sayılır");
  assert.deepEqual(bad.platform, ["nextjs"], "geçersiz platform elenir");
  assert.equal(activeFilterCount({ ...DEFAULT_FILTERS, kind: "shopify", platform: ["shopify"] }), 2);

  // 7) CSV: tür ve platform sütunları
  const { GET } = await import("../src/app/stores/export/route");
  const res = await GET(new Request("http://localhost/stores/export?tip=genel&platform=nextjs"));
  const csv = (await res.text()).replace(/^﻿/, "");
  const [header, ...lines] = csv.split("\r\n");
  const cols = header.split(",");
  assert.deepEqual(cols.slice(0, 5), ["domain", "marka", "tur", "platform", "durum"]);
  assert.equal(lines.length, 1, "yalnızca g.com");
  const row = lines[0].split(",");
  assert.equal(row[0], "g.com");
  assert.equal(row[cols.indexOf("tur")], "genel");
  assert.equal(row[cols.indexOf("platform")], "Next.js");
  const shopifyCsv = (await (await GET(new Request("http://localhost/stores/export?tip=shopify"))).text()).split("\r\n");
  assert.equal(shopifyCsv.length - 1, 5, "Shopify CSV: 5 satır");
  assert.ok(shopifyCsv.slice(1).every((l) => l.split(",")[2] === "shopify"), "tüm satırlar tür=shopify");

  db.$client.close();
  for (const f of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_FILE}${f}`, { force: true });
  console.log("✓ tür/platform filtresi kontrolleri geçti");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
