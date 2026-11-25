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

  console.log("\n✓ tüm keşif kontrolleri geçti");
  db.$client.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
