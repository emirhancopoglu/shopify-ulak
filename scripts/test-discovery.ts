/**
 * Keşif dayanıklılık testi: engel / ağ hatası / yeniden başlama / iptal senaryoları.
 * Ağa çıkmaz (DuckDuckGo ve saat sahte), ayrı bir DB kullanır:
 *   npm run test:discovery
 */
import fs from "node:fs";
import assert from "node:assert/strict";

process.env.DB_FILE = "data/test-discovery.db";

async function main() {
  for (const f of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_FILE}${f}`, { force: true });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { db, DB_PATH } = await import("../src/db");
  const { createRun, getRun, cancelRun, resumeRun, saveStats, setRunStatus } = await import("../src/lib/discovery/runs");
  const { runDiscovery, BLOCK_WAITS_MS, ERROR_WAITS_MS } = await import("../src/lib/discovery/runner");
  type SearchFn = import("../src/lib/discovery/runner").RunnerDeps["search"];

  assert(DB_PATH.includes("test-discovery"), "Bu test sadece ayrı test DB'si ile çalışır");
  migrate(db, { migrationsFolder: "./drizzle" });

  let t = 1_000_000_000;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  const MIN = 60_000;

  const newRun = (queries: string[]) => {
    const id = createRun("search", { queries, trOnly: true }, queries.length);
    db.$client.prepare(`DELETE FROM jobs`).run(); // worker yok; işi doğrudan çalıştırıyoruz
    return id;
  };
  const ok = { blocked: false as const, hosts: [] as string[] };
  const blocked = { blocked: true as const, hosts: [] as string[] };
  /** Sırayla verilen yanıtları döndürür ("err" → hata fırlatır); bitince hep başarılı. */
  const scripted = (seq: ("ok" | "blocked" | "err")[]) => {
    const calls: number[] = [];
    const fn = (async () => {
      calls.push(t);
      const next = seq.shift() ?? "ok";
      if (next === "err") throw new Error("fetch failed");
      return next === "blocked" ? blocked : ok;
    }) as unknown as SearchFn;
    return { fn, calls };
  };

  // 1) İki engel → otomatik bekleyip devam eder, bitirir
  {
    const id = newRun(["q1", "q2", "q3"]);
    const s = scripted(["ok", "blocked", "blocked"]);
    const start = t;
    await runDiscovery(id, { search: s.fn, ...clock });
    const run = getRun(id)!;
    assert.equal(run.status, "done", "engelden sonra kendiliğinden bitmeli");
    assert.equal(run.stats.cursor, 3);
    assert.equal(run.stats.blockStreak, 0, "başarıdan sonra sayaç sıfırlanır");
    assert.equal(run.stats.waitUntil ?? null, null, "bekleme bilgisi temizlenir");
    assert.equal(s.calls.length, 5);
    assert.ok(s.calls[2] - s.calls[1] >= BLOCK_WAITS_MS[0], "1. engelde 5 dk bekler");
    assert.ok(s.calls[3] - s.calls[2] >= BLOCK_WAITS_MS[1], "2. engelde 10 dk bekler");
    assert.ok(s.calls[4] - s.calls[3] > 16_000, "engelden sonra sorgu aralığı uzar (pace > 1)");
    assert.ok(run.log.some((l) => l.includes("yavaşlattı")));
    assert.ok(t - start >= 15 * MIN);
    console.log("engel → otomatik devam: geçti");
  }

  // 2) Geçici ağ hatası → aynı sorgu tekrar denenir
  {
    const id = newRun(["q1", "q2"]);
    const s = scripted(["err", "err", "ok", "ok"]);
    await runDiscovery(id, { search: s.fn, ...clock });
    const run = getRun(id)!;
    assert.equal(run.status, "done", "geçici hata çalıştırmayı durdurmamalı");
    assert.equal(run.stats.cursor, 2);
    assert.ok(s.calls[1] - s.calls[0] >= ERROR_WAITS_MS[0]);
    assert.ok(s.calls[2] - s.calls[1] >= ERROR_WAITS_MS[1]);
    console.log("geçici hata → tekrar deneme: geçti");
  }

  // 3) Kalıcı ağ hatası → anlaşılır mesajla "failed", imleç yerinde
  {
    const id = newRun(["q1", "q2"]);
    const s = scripted(["ok", "err", "err", "err", "err"]);
    await runDiscovery(id, { search: s.fn, ...clock });
    const run = getRun(id)!;
    assert.equal(run.status, "failed");
    assert.equal(run.stats.cursor, 1, "başarısız sorgu atlanmaz");
    assert.match(run.error ?? "", /ulaşılamıyor.*Devam ettir/);
    assert.equal(s.calls.length, 1 + 1 + ERROR_WAITS_MS.length);
    console.log("kalıcı hata → failed: geçti");
  }

  // 4) Sürekli engel → tüm beklemeler tükenince "blocked"; "Devam ettir" sayacı sıfırlar
  {
    const id = newRun(["q1", "q2"]);
    const s = scripted(Array(10).fill("blocked"));
    await runDiscovery(id, { search: s.fn, ...clock });
    let run = getRun(id)!;
    assert.equal(run.status, "blocked");
    assert.equal(s.calls.length, BLOCK_WAITS_MS.length + 1);
    assert.match(run.error ?? "", /uzun süredir/);
    assert.equal(run.stats.blockStreak, BLOCK_WAITS_MS.length);
    assert.ok(resumeRun(id));
    run = getRun(id)!;
    assert.equal(run.status, "queued");
    assert.equal(run.stats.blockStreak, 0);
    db.$client.prepare(`DELETE FROM jobs`).run();
    await runDiscovery(id, { search: scripted([]).fn, ...clock });
    assert.equal(getRun(id)!.status, "done");
    console.log("sürekli engel → blocked + devam ettir: geçti");
  }

  // 5) Worker bekleme sırasında yeniden başladı → kalan süre beklenir, sonra devam
  {
    const id = newRun(["q1"]);
    const run0 = getRun(id)!;
    saveStats(id, { ...run0.stats, waitUntil: t + 10 * MIN, waitReason: "DuckDuckGo yavaşlattı", blockStreak: 2 });
    setRunStatus(id, "running");
    const s = scripted([]);
    const start = t;
    await runDiscovery(id, { search: s.fn, ...clock });
    assert.ok(s.calls[0] - start >= 10 * MIN, "yeniden başlamada önce kalan bekleme tamamlanır");
    assert.equal(getRun(id)!.status, "done");
    console.log("yeniden başlamada bekleme korunur: geçti");
  }

  // 6) Bekleme sırasında iptal → hemen çıkar, durum "cancelled", bekleme bilgisi temiz
  {
    const id = newRun(["q1", "q2"]);
    const s = scripted(["blocked"]);
    let slept = 0;
    const sleep = async (ms: number) => {
      t += ms;
      if (++slept === 3) cancelRun(id);
    };
    await runDiscovery(id, { search: s.fn, now: clock.now, sleep });
    const run = getRun(id)!;
    assert.equal(run.status, "cancelled");
    assert.equal(run.stats.waitUntil ?? null, null);
    assert.equal(s.calls.length, 1);
    console.log("bekleme sırasında iptal: geçti");
  }

  // 7) Paralel: kaynak başına tek aktif çalıştırma; keşif işleri analiz yuvalarından ayrı alınır
  {
    const { hasActiveRun } = await import("../src/lib/discovery/runs");
    const { claimJobs, enqueue } = await import("../src/lib/jobs");
    db.$client.prepare(`DELETE FROM discovery_runs`).run();
    db.$client.prepare(`DELETE FROM jobs`).run();
    createRun("search", { queries: ["q"] }, 1);
    assert.ok(hasActiveRun("search"));
    assert.ok(!hasActiveRun("dns"), "başka kaynak meşgul sayılmaz");
    assert.ok(hasActiveRun());
    enqueue("analyze_store", [{ storeId: 1 }, { storeId: 2 }]);
    const discover = claimJobs(5, "discover");
    assert.equal(discover.length, 1);
    assert.equal(discover[0].type, "discover");
    const analyze = claimJobs(5, "analyze_store");
    assert.equal(analyze.length, 2);
    assert.ok(analyze.every((j) => j.type === "analyze_store"));
    console.log("paralel kaynaklar + ayrı iş yuvaları: geçti");
  }

  // 8) Alan adı listesi süzme: yalnız .tr, sıralı listede .tr bitince durur, kopan bağlantıda Range ile devam
  {
    const zlib = await import("node:zlib");
    const { extractTldDomains, cacheFile, readCachedList } = await import("../src/lib/discovery/domainlist");
    const lines = ["0\tcom.alfa\t1", "1\tcom.beta\t2"];
    // .tr satırları, ilk bağlantının koptuğu yerden sonra gelsin
    for (let k = 0; k < 6000; k++) lines.push(`${lines.length}\tde.x${(k * 7919).toString(36)}\t1`);
    lines.push(`${lines.length}\ttr.com.ornek\t3`, `${lines.length + 1}\ttr.com.ornek\t1`, `${lines.length + 2}\ttr.org.dernek\t1`, `${lines.length + 3}\ttr\t1`);
    for (let k = 0; k < 3000; k++) lines.push(`${lines.length}\tua.com.x${String(k).padStart(5, "0")}\t1`);
    const gz = zlib.gzipSync(Buffer.from(lines.join("\n") + "\n"));
    const half = Math.floor(gz.length / 3);
    const ranges: string[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      ranges.push(range ?? "");
      if (!range) {
        // ilk bağlantı üçte birde kopar
        let sent = false;
        const body = new ReadableStream({
          pull(c) {
            if (sent) return c.error(new Error("socket hang up"));
            sent = true;
            c.enqueue(new Uint8Array(gz.subarray(0, half)));
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": String(gz.length) } });
      }
      const from = Number(/bytes=(\d+)-/.exec(range)![1]);
      return new Response(new Uint8Array(gz.subarray(from)), { status: 206 });
    }) as unknown as typeof fetch;
    const graph = "test-graph";
    fs.rmSync(cacheFile(graph, ["tr"]), { force: true });
    const list = await extractTldDomains(graph, ["tr"], { fetchFn: fakeFetch });
    assert.deepEqual(list, ["ornek.com.tr", "dernek.org.tr"], "yalnız .tr, tekrarsız, çıplak uzantı yok");
    assert.equal(ranges.length, 2);
    assert.equal(ranges[1], `bytes=${half}-`, "kaldığı bayttan devam eder");
    assert.deepEqual(readCachedList(graph, ["tr"]), list, "önbelleğe yazıldı");
    fs.rmSync(cacheFile(graph, ["tr"]), { force: true });
    console.log("liste süzme + kopan bağlantıda devam: geçti");
  }

  // 9) Alan adı arşivi çalıştırması: liste → DNS süzgeci → yalnız Shopify olanlar eklenir; listede olanlara DNS sorulmaz
  {
    const { addStores } = await import("../src/lib/stores");
    const { cacheFile } = await import("../src/lib/discovery/domainlist");
    const graph = "test-graph-run";
    fs.rmSync(cacheFile(graph, ["tr"]), { force: true });
    addStores(["zaten.invalid"], "manual");
    const domains = ["a1.invalid", "shop1.invalid", "zaten.invalid", "a2.invalid", "shop2.invalid"];
    const asked: string[] = [];
    const id = createRun("ccdomains", { graph, tlds: ["tr"], trOnly: false }, 0);
    db.$client.prepare(`DELETE FROM jobs`).run();
    await runDiscovery(id, {
      ...clock,
      extractDomains: async (_g, _t, o) => {
        o?.onProgress?.({ bytes: 50, totalBytes: 100, found: domains.length });
        return domains;
      },
      isShopifyDns: async (d) => {
        asked.push(d);
        return d.startsWith("shop");
      },
    });
    const run = getRun(id)!;
    assert.equal(run.status, "done", run.error ?? "");
    assert.equal(run.stats.total, 5);
    assert.equal(run.stats.cursor, 5);
    assert.ok(!asked.includes("zaten.invalid"), "listede olana DNS sorulmaz");
    assert.equal(run.stats.added, 2, "yalnız DNS'i Shopify olan 2 alan adı eklenir");
    assert.equal(run.stats.note ?? null, null);
    const added = db.$client.prepare(`SELECT domain FROM stores WHERE source = 'ccdomains' ORDER BY domain`).all() as { domain: string }[];
    assert.deepEqual(added.map((r) => r.domain), ["shop1.invalid", "shop2.invalid"]);
    console.log("alan adı arşivi → DNS → ekleme: geçti");
  }

  // 10) Tranco: listenin yalnız istenen dilimi taranır
  {
    const list = ["google.invalid", "shopa.invalid", "x.invalid", "shopb.invalid"];
    const asked: string[] = [];
    const id = createRun("tranco", { listId: "TEST1", start: 1, limit: 2, trOnly: false }, 2);
    db.$client.prepare(`DELETE FROM jobs`).run();
    await runDiscovery(id, {
      ...clock,
      trancoList: async () => list,
      isShopifyDns: async (d) => {
        asked.push(d);
        return d.startsWith("shop");
      },
    });
    const run = getRun(id)!;
    assert.equal(run.status, "done", run.error ?? "");
    assert.deepEqual(asked, ["shopa.invalid", "x.invalid"], "yalnız 2.-3. siteler");
    assert.equal(run.stats.added, 1);
    console.log("tranco dilimi: geçti");
  }

  // 11) Wayback: urlkey → myshopify adresi; sayfa sayısı, kaldığı sayfa ve istekler arası bekleme
  {
    const { hostFromUrlkey, waybackNextPage } = await import("../src/lib/discovery/wayback");
    assert.equal(hostFromUrlkey("com,myshopify,12knives)/products/x"), "12knives.myshopify.com");
    assert.equal(hostFromUrlkey("com,myshopify,bello-vida:80)/"), "bello-vida.myshopify.com");
    assert.equal(hostFromUrlkey("com,myshopify,www)/"), null);
    assert.equal(hostFromUrlkey("com,myshopify)/admin"), null);
    assert.equal(hostFromUrlkey("com,example,shop)/"), null);

    const pagesAsked: number[] = [];
    const id = createRun("wayback", { startPage: 8, pageCount: 5, trOnly: true }, 5);
    db.$client.prepare(`DELETE FROM jobs`).run();
    await runDiscovery(id, {
      ...clock,
      waybackPages: async () => 10,
      waybackHosts: async (page) => {
        pagesAsked.push(t);
        if (pagesAsked.length === 2 && page === 9) throw new Error("Wayback HTTP 503");
        return [];
      },
    });
    const run = getRun(id)!;
    assert.equal(run.status, "done", run.error ?? "");
    assert.equal(run.stats.total, 2, "toplam 10 sayfa: 8 ve 9 kalır");
    assert.equal(waybackNextPage(), 10);
    assert.ok(pagesAsked[1] - pagesAsked[0] >= 4_000, "sayfalar arası bekler");
    assert.ok(pagesAsked[2] - pagesAsked[1] >= 60_000, "hata sonrası 1 dk bekleyip tekrar dener");
    console.log("wayback sayfaları: geçti");
  }

  // 12) Genel siteler: DNS → ana sayfa platformu → yalnız seçili platformlar eklenir.
  // Shopify izi Shopify sekmesine aittir (atlanır), DNS'te olmayan ve açılmayan adresler ölü sayılır, .tr dışı elenir.
  // Popüler siteler (Tranco), alan adında haber/avukat/kamu kelimesi geçenler ve ana sayfası haber/avukat/kamu olanlar elenir.
  {
    const { DEFAULT_GENERAL_PLATFORMS } = await import("../src/lib/platform-labels");
    const { GENERAL_SOURCES, isGeneralSource } = await import("../src/lib/discovery/source-groups");
    assert.deepEqual(DEFAULT_GENERAL_PLATFORMS, ["nextjs", "react", "angular", "vue", "nuxt", "wordpress"]);
    assert.ok(isGeneralSource("general_tranco") && !isGeneralSource("tranco"));
    assert.equal(GENERAL_SOURCES.length, 2);

    type Probe = import("../src/lib/discovery/general-probe").GeneralProbe;
    const list = [
      "alfa-web.com.tr",
      "beta-next.com.tr",
      "gamma-shop.com.tr",
      "delta-dead.com.tr",
      "epsilon-react.com.tr",
      "zeta-plain.com.tr",
      "x.com",
      "populer-site.com.tr", // Tranco'da: elenir
      "ahmetavukatlik.com.tr", // alan adında avukat: elenir
      "yerelhaber.com.tr", // alan adında haber: elenir
      "sekerci.com.tr", // ana sayfası haber sitesi: elenir
    ];
    const probed: string[] = [];
    const dnsAsked: string[] = [];
    const next = (platform: Probe["platform"], extra: Partial<Probe> = {}): Probe => ({ reachable: true, shopify: false, platform, confidence: "high", language: "tr", segment: null, ...extra });
    const probes: Record<string, Probe> = {
      "alfa-web.com.tr": next("nextjs"),
      "beta-next.com.tr": next("nextjs"),
      "gamma-shop.com.tr": next("shopify", { shopify: true }),
      "epsilon-react.com.tr": next("react", { confidence: "medium" }),
      "zeta-plain.com.tr": next("unknown", { confidence: "low" }),
      "sekerci.com.tr": next("nextjs", { segment: "news" }),
    };
    const unreachable: Probe = { reachable: false, shopify: false, platform: "unknown", confidence: "low", language: null };
    const probeSite = async (d: string) => {
      probed.push(d);
      return probes[d] ?? unreachable;
    };
    const popularDomains = async () => ["google.com", "populer-site.com.tr"];
    const params = { graph: "TEST-G12", tlds: ["tr"], start: 0, limit: list.length, platforms: DEFAULT_GENERAL_PLATFORMS, trOnly: true };
    const id = createRun("general_ccdomains", params, list.length);
    db.$client.prepare(`DELETE FROM jobs`).run();
    await runDiscovery(id, {
      ...clock,
      extractDomains: async () => list,
      popularDomains,
      hasDns: async (d) => {
        dnsAsked.push(d);
        return d !== "delta-dead.com.tr";
      },
      probeSite,
    });
    const run = getRun(id)!;
    assert.equal(run.status, "done", run.error ?? "");
    for (const skipped of ["x.com", "populer-site.com.tr", "ahmetavukatlik.com.tr", "yerelhaber.com.tr"]) {
      assert.ok(!dnsAsked.includes(skipped), `${skipped}: DNS sorulmamalı`);
    }
    assert.deepEqual([...probed].sort(), ["alfa-web.com.tr", "beta-next.com.tr", "epsilon-react.com.tr", "gamma-shop.com.tr", "sekerci.com.tr", "zeta-plain.com.tr"]);
    assert.equal(run.stats.dead, 1, "DNS'te olmayan delta ölü sayılır");
    assert.equal(run.stats.shopify, 1, "Shopify izi olan gamma atlanır");
    assert.equal(run.stats.popular, 1, "popüler site elenir");
    assert.equal(run.stats.excluded, 3, "alan adında avukat + haber, ana sayfada haber");
    assert.equal(run.stats.matched, 3, "nextjs ×2 + react eşleşir; unknown seçili değil");
    assert.equal(run.stats.added, 3);
    const rows = db.$client.prepare(`SELECT domain FROM stores WHERE source = 'general_ccdomains' ORDER BY domain`).all() as { domain: string }[];
    assert.deepEqual(rows.map((r) => r.domain), ["alfa-web.com.tr", "beta-next.com.tr", "epsilon-react.com.tr"]);

    // Genel kaynak yeniden çalıştırılınca bilinen adresler atlanır
    const again = createRun("general_ccdomains", params, list.length);
    db.$client.prepare(`DELETE FROM jobs`).run();
    probed.length = 0;
    await runDiscovery(again, { ...clock, extractDomains: async () => list, popularDomains, hasDns: async () => true, probeSite });
    const second = getRun(again)!;
    assert.equal(second.stats.known, 3, "zaten listede olan 3 site");
    assert.equal(second.stats.added, 0);

    // Popüler site listesi alınamazsa tarama başlamadan durur (filtresiz tarama yapılmaz)
    const noList = createRun("general_ccdomains", { ...params, graph: "TEST-G12B" }, list.length);
    db.$client.prepare(`DELETE FROM jobs`).run();
    await runDiscovery(noList, {
      ...clock,
      extractDomains: async () => list,
      popularDomains: async () => {
        throw new Error("ağ yok");
      },
      hasDns: async () => true,
      probeSite,
    });
    const failed = getRun(noList)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /Popüler site listesi/);
    console.log("genel siteler: geçti");
  }

  // 13) Genel Common Crawl taraması: liste alfabetik gelir; avukat/kamu uzantıları elenir, sıra sabit tohumla karışır,
  // art arda dilimler çakışmaz ve tek uzantı bloğu taramayı doldurmaz.
  {
    const { isExcludedSuffix, seededShuffle } = await import("../src/lib/discovery/domain-order");
    const { DEFAULT_GENERAL_PLATFORMS } = await import("../src/lib/platform-labels");
    for (const d of ["izmir.bel.tr", "ankara.gov.tr", "ODTU.EDU.TR", "okul.k12.tr", "avukat.av.tr"]) assert.ok(isExcludedSuffix(d), d);
    for (const d of ["firma.com.tr", "belediye.com.tr", "dernek.org.tr", "ornek.tr"]) assert.ok(!isExcludedSuffix(d), d);

    const lawyers = Array.from({ length: 60 }, (_, i) => `avukat${String(i).padStart(2, "0")}.av.tr`);
    const councils = Array.from({ length: 20 }, (_, i) => `belediye${i}.bel.tr`);
    const others = Array.from({ length: 40 }, (_, i) => `site${String(i).padStart(2, "0")}.com.tr`);
    const orgs = Array.from({ length: 40 }, (_, i) => `dernek${String(i).padStart(2, "0")}.org.tr`);
    const alphabetical = [...lawyers, ...councils, ...others, ...orgs];

    const a = seededShuffle(alphabetical, "G1");
    assert.deepEqual(a, seededShuffle(alphabetical, "G1"), "aynı tohum aynı sırayı vermeli");
    assert.notDeepEqual(a, seededShuffle(alphabetical, "G2"), "farklı tohum farklı sıra vermeli");
    assert.deepEqual([...a].sort(), [...alphabetical].sort(), "karıştırma öğe kaybetmemeli");
    assert.equal(alphabetical[0], lawyers[0], "girdi listesi değişmemeli");

    type Probe = import("../src/lib/discovery/general-probe").GeneralProbe;
    const dead: Probe = { reachable: false, shopify: false, platform: "unknown", confidence: "low", language: null };
    const runSlice = async (start: number, limit: number) => {
      const probed: string[] = [];
      const id = createRun("general_ccdomains", { graph: "TEST-SHUFFLE", tlds: ["tr"], start, limit, platforms: DEFAULT_GENERAL_PLATFORMS, trOnly: true }, limit);
      db.$client.prepare(`DELETE FROM jobs`).run();
      await runDiscovery(id, {
        ...clock,
        extractDomains: async () => alphabetical,
        popularDomains: async () => [],
        hasDns: async () => true,
        probeSite: async (d) => {
          probed.push(d);
          return dead;
        },
      });
      const run = getRun(id)!;
      assert.equal(run.status, "done", run.error ?? "");
      return probed;
    };
    const first = await runSlice(0, 40);
    const second = await runSlice(40, 40);
    assert.equal(first.length, 40);
    assert.equal(second.length, 40);
    assert.ok(![...first, ...second].some((d) => d.endsWith(".bel.tr") || d.endsWith(".av.tr")), "avukat ve belediye siteleri taranmamalı");
    assert.ok(first.some((d) => d.endsWith(".com.tr")) && first.some((d) => d.endsWith(".org.tr")), "ilk dilim karışık olmalı");
    assert.equal(first.filter((d) => second.includes(d)).length, 0, "art arda dilimler çakışmamalı");
    assert.deepEqual([...first, ...second].sort(), [...others, ...orgs].sort(), "kalan 80 alan adı iki dilimde eksiksiz taranmalı");
    console.log("genel ccdomains sırası: geçti");
  }

  // 14) Hedef dışı tür tanıma (haber, avukat, kamu): alan adı ve ana sayfa başlığından
  {
    const { segmentFromDomain, segmentFromHomepage, homepageHints, segmentForStoredSite } = await import("../src/lib/discovery/segments");
    const cases: [string, string | null][] = [
      ["sivashaberin.com.tr", "news"],
      ["ankaragazetesi.com.tr", "news"],
      ["yeniavukatlik.com.tr", "legal"],
      ["ozdemirhukuk.com.tr", "legal"],
      ["kadikoybelediyesi.com.tr", "public"],
      ["istanbulvalilik.com.tr", "public"],
      ["monoterapi.com.tr", null], // "noter" alt dizesi: avukat/noter sınıflanmamalı
      ["kahvecim.com.tr", null],
      ["modaevi.com.tr", null],
      ["newsletter-studio.com.tr", null],
    ];
    for (const [d, want] of cases) assert.equal(segmentFromDomain(d), want, d);

    const page = (title: string, extra = "") => segmentFromHomepage(homepageHints(`<html><head><title>${title}</title>${extra}</head><body></body></html>`));
    assert.equal(page("Yıldız Hukuk Bürosu | Ana Sayfa"), "legal");
    assert.equal(page("Av. Ayşe Demir - Avukat"), "legal");
    assert.equal(page("Son Dakika Haberleri - Yerel Gazete"), "news");
    assert.equal(page("Kartal Belediyesi"), "public");
    assert.equal(page("Fen İşleri Müdürlüğü"), "public");
    assert.equal(page("Çiçek Dünyası - Online Çiçek Siparişi"), null);
    assert.equal(page("Ofis Mobilya | Ankara"), null);
    assert.equal(page("Anasayfa", `<meta property="og:site_name" content="Sakarya Haber Merkezi">`), "news");
    assert.equal(page("Anasayfa", `<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsMediaOrganization","name":"X"}</script>`), "news");
    // Açıklama metni dikkate alınmaz: e-ticaret açıklamasında "haber" geçebilir
    assert.equal(page("Mavi Butik", `<meta name="description" content="Kampanyalardan haber alın, hukuk kitapları da var">`), null);
    // Kayıtlı site (eski kayıt temizliği): alan adı ya da marka adından
    assert.equal(segmentForStoredSite({ domain: "ornek.com.tr", brandName: "Demir Hukuk Bürosu" }), "legal");
    assert.equal(segmentForStoredSite({ domain: "ornek.com.tr", brandName: "Ornek Mobilya" }), null);
    console.log("hedef dışı tür tanıma: geçti");
  }

  console.log("\n✓ tüm keşif kontrolleri geçti");
  db.$client.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
