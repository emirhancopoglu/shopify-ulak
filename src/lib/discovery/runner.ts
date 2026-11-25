import { db } from "@/db";
import type { DiscoveryRun, DiscoveryStats } from "@/db/schema";
import { describeError } from "@/lib/analyzer/http";
import { normalizeDomain } from "@/lib/domains";
import { addStores } from "@/lib/stores";
import { numPages, pageHosts, saveNextPage } from "./commoncrawl";
import { ddgSearch } from "./ddg";
import { extractTldDomains, readCachedList, type ExtractProgress } from "./domainlist";
import { trancoDomains } from "./tranco";
import { saveWaybackNextPage, waybackPageCount, waybackPageHosts } from "./wayback";
import { looksLikeShopify } from "./dns";
import { isTurkish, probeStore } from "./probe";
import { appendLog, getRun, isCancelled, saveStats, setRunStatus } from "./runs";

/**
 * Keşif çalıştırması (worker'daki "discover" işi). Kaldığı yeri stats.cursor'da tutar:
 * worker yeniden başlarsa ya da kullanıcı "devam ettir" derse oradan sürer.
 * Hata fırlatmaz (iş kuyruğu otomatik tekrar denemesin); durumu kendisi yazar.
 */
export async function runDiscovery(runId: number, deps: Partial<RunnerDeps> = {}) {
  const run = getRun(runId);
  if (!run || run.status === "cancelled" || run.status === "done") return;
  setRunStatus(runId, "running");
  const ctx = new Context(run, { ...defaultDeps, ...deps });
  try {
    if (run.source === "search") await runSearch(ctx);
    else if (run.source === "commoncrawl") await runCommonCrawl(ctx);
    else if (run.source === "dns") await runDns(ctx);
    else if (run.source === "ccdomains") await runCcDomains(ctx);
    else if (run.source === "tranco") await runTranco(ctx);
    else if (run.source === "wayback") await runWayback(ctx);
    if (ctx.stopped) return; // iptal/engel durumu zaten yazıldı
    ctx.save();
    setRunStatus(runId, "done");
    appendLog(runId, `Bitti: ${ctx.stats.added} yeni mağaza eklendi.`);
  } catch (err) {
    ctx.save();
    const msg = describeError(err);
    setRunStatus(runId, "failed", msg);
    appendLog(runId, `Hata: ${msg}`);
  }
}

// ---------------------------------------------------------------------------

const SOURCE_TAG: Record<DiscoveryRun["source"], string> = {
  search: "search",
  commoncrawl: "commoncrawl",
  dns: "dns",
  ccdomains: "ccdomains",
  tranco: "tranco",
  wayback: "wayback",
};

/** Testlerde ağ ve saat yerine sahte sürümler verilebilsin diye. */
export type RunnerDeps = {
  search: typeof ddgSearch;
  isShopifyDns: typeof looksLikeShopify;
  extractDomains: typeof extractTldDomains;
  trancoList: (listId: string) => Promise<string[]>;
  waybackPages: () => Promise<number>;
  waybackHosts: (page: number) => Promise<string[]>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const defaultDeps: RunnerDeps = {
  search: ddgSearch,
  isShopifyDns: looksLikeShopify,
  extractDomains: extractTldDomains,
  trancoList: (listId) => trancoDomains(listId),
  waybackPages: waybackPageCount,
  waybackHosts: waybackPageHosts,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

class Context {
  stats: DiscoveryStats;
  stopped = false;
  private seen = new Set<string>();

  constructor(
    readonly run: DiscoveryRun,
    readonly deps: RunnerDeps,
  ) {
    this.stats = { ...run.stats };
  }

  get trOnly() {
    return this.run.params.trOnly !== false;
  }

  save() {
    saveStats(this.run.id, this.stats);
  }

  log(msg: string) {
    appendLog(this.run.id, msg);
  }

  /** İptal edildiyse true (durum zaten "cancelled"). */
  cancelled(): boolean {
    if (isCancelled(this.run.id)) {
      this.stopped = true;
      this.save();
      return true;
    }
    return false;
  }

  /** İptali kontrol ederek bekle. İptal edildiyse false. */
  async wait(ms: number): Promise<boolean> {
    const end = this.deps.now() + ms;
    while (this.deps.now() < end) {
      if (this.cancelled()) return false;
      await this.deps.sleep(Math.min(2000, end - this.deps.now()));
    }
    return true;
  }

  /** Kartta "şu saatte devam edecek" gösterilecek şekilde bekle. İptal edildiyse false. */
  async pause(ms: number, reason: string): Promise<boolean> {
    this.stats.waitUntil = this.deps.now() + ms;
    this.stats.waitReason = reason;
    this.save();
    const ok = await this.wait(ms);
    this.stats.waitUntil = null;
    this.stats.waitReason = null;
    this.save();
    return ok;
  }

  /** Worker bekleme sırasında yeniden başladıysa kalan süreyi tamamla (kaynağa hemen tekrar gitme). */
  async finishPendingWait(): Promise<boolean> {
    const left = (this.stats.waitUntil ?? 0) - this.deps.now();
    if (left <= 0) {
      if (this.stats.waitUntil) {
        this.stats.waitUntil = null;
        this.stats.waitReason = null;
        this.save();
      }
      return true;
    }
    this.log(`Önceki bekleme sürüyor; ${Math.ceil(left / 60_000)} dk sonra devam edilecek.`);
    return this.pause(left, this.stats.waitReason ?? "Bekleniyor");
  }

  /**
   * fn'i dener; hata olursa `waitsMs` sürelerince bekleyip tekrar dener.
   * Denemeler tükenirse `{ error }`, iptal edilirse null döner (durum yazmak çağıranın işi).
   */
  async retrying<T>(fn: () => Promise<T>, waitsMs: number[], what: string, reason: string): Promise<{ value: T } | { error: unknown } | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return { value: await fn() };
      } catch (err) {
        if (attempt >= waitsMs.length) return { error: err };
        const ms = waitsMs[attempt];
        this.log(`${what} (${describeError(err)}); ${fmtWait(ms)} sonra tekrar denenecek…`);
        if (!(await this.pause(ms, reason))) return null;
      }
    }
  }

  stop(status: "blocked" | "failed", message: string) {
    this.stopped = true;
    this.save();
    setRunStatus(this.run.id, status, message);
    this.log(message);
  }

  /**
   * Aday adresleri işler: listede var mı → Shopify mı (meta.json) → filtreye uyuyor mu → asıl alan adıyla ekle.
   * `dnsChecked`: DNS zaten Shopify dedi; meta.json alınamazsa (ve TR filtresi yoksa) yine de ekle.
   */
  async ingest(hosts: string[], opts: { concurrency?: number; dnsChecked?: boolean } = {}) {
    const fresh: string[] = [];
    for (const h of hosts) {
      const host = normalizeDomain(h);
      if (!host || this.seen.has(host)) continue;
      this.seen.add(host);
      this.stats.candidates++;
      if (storeExists(host)) this.stats.known++;
      else fresh.push(host);
    }

    const toAdd: string[] = [];
    let i = 0;
    const worker = async () => {
      while (i < fresh.length) {
        const host = fresh[i++];
        let p;
        try {
          p = await probeStore(host);
        } catch {
          continue;
        }
        if (!p.shopify) {
          if (opts.dnsChecked && !this.trOnly) {
            this.stats.shopify++;
            this.stats.matched++;
            toAdd.push(host);
          }
          continue;
        }
        this.stats.shopify++;
        if (this.trOnly && !isTurkish(p)) continue;
        this.stats.matched++;
        if (storeExists(p.domain) || (p.myshopify && storeExists(p.myshopify))) {
          this.stats.known++;
          continue;
        }
        toAdd.push(p.domain);
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));

    if (toAdd.length) {
      const { added } = addStores([...new Set(toAdd)], SOURCE_TAG[this.run.source]);
      this.stats.added += added;
    }
    this.save();
    return toAdd.length;
  }
}

/** Alan adı ya da myshopify adresiyle listede var mı? */
function storeExists(host: string): boolean {
  return Boolean(db.$client.prepare(`SELECT 1 FROM stores WHERE domain = ? OR myshopify_domain = ? LIMIT 1`).get(host, host));
}

const jitter = (min: number, max: number) => min + Math.random() * (max - min);
const fmtWait = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} sn` : `${Math.round(ms / 60_000)} dk`);

/** Art arda DuckDuckGo engellerinde beklenecek süreler. Hepsi tükenirse (≈95 dk) çalıştırma "engellendi" olur. */
export const BLOCK_WAITS_MS = [5, 10, 20, 30, 30].map((m) => m * 60_000);
/** Ağ / sunucu hatalarında aynı isteği tekrar denemeden önceki beklemeler. */
export const ERROR_WAITS_MS = [30_000, 60_000, 120_000];
/** Common Crawl sayfası (iç denemelerden sonra da) alınamazsa ek beklemeler. */
export const CC_PAGE_WAITS_MS = [2 * 60_000, 5 * 60_000];
/** Sorgular arası temel aralık (ms); engelden sonra `pace` çarpanıyla uzar. */
const QUERY_GAP_MS: [number, number] = [10_000, 16_000];
const MAX_PACE = 3;

// ---------------------------------------------------------------------------
// Kaynak 1: DuckDuckGo araması
// ---------------------------------------------------------------------------

async function runSearch(ctx: Context) {
  const queries = (ctx.run.params.queries as string[]) ?? [];
  ctx.stats.total = queries.length;
  if (!(await ctx.finishPendingWait())) return;
  // Engelden sonra sorgu aralığı çarpanı; başarılı sorgularla yavaşça 1'e döner
  let pace = Math.min(MAX_PACE, 1 + (ctx.stats.blockStreak ?? 0) * 0.5);

  while (ctx.stats.cursor < queries.length) {
    if (ctx.cancelled()) return;
    const q = queries[ctx.stats.cursor];

    const attempt = await ctx.retrying(() => ctx.deps.search(q), ERROR_WAITS_MS, "DuckDuckGo'ya ulaşılamadı", "Bağlantı hatası, tekrar denenecek");
    if (attempt === null) return; // iptal
    if ("error" in attempt) {
      return ctx.stop(
        "failed",
        `DuckDuckGo'ya ulaşılamıyor (${describeError(attempt.error)}). İnternet bağlantısını kontrol edip "Devam ettir" ile kaldığı yerden sürdürün.`,
      );
    }
    const res = attempt.value;

    if (res.blocked) {
      const streak = ctx.stats.blockStreak ?? 0;
      if (streak >= BLOCK_WAITS_MS.length) {
        return ctx.stop(
          "blocked",
          `DuckDuckGo uzun süredir engelliyor (${ctx.stats.cursor}/${queries.length} sorgu tamamlandı). Birkaç saat sonra "Devam ettir" ile kaldığı yerden sürdürün.`,
        );
      }
      const ms = BLOCK_WAITS_MS[streak];
      ctx.stats.blockStreak = streak + 1;
      pace = Math.min(MAX_PACE, pace + 0.5);
      ctx.log(`DuckDuckGo yavaşlattı (art arda ${streak + 1}. kez); ${fmtWait(ms)} bekleyip otomatik devam edilecek…`);
      if (!(await ctx.pause(ms, "DuckDuckGo yavaşlattı"))) return;
      continue; // aynı sorguyu tekrar dene
    }
    ctx.stats.blockStreak = 0;

    const before = ctx.stats.added;
    await ctx.ingest(res.hosts);
    ctx.stats.cursor++;
    ctx.save();
    ctx.log(`"${q}" → ${res.hosts.length} sonuç, ${ctx.stats.added - before} yeni mağaza`);
    pace = Math.max(1, pace - 0.1);

    if (ctx.stats.cursor < queries.length && !(await ctx.wait(jitter(QUERY_GAP_MS[0] * pace, QUERY_GAP_MS[1] * pace)))) return;
  }
}

// ---------------------------------------------------------------------------
// Kaynak 2: Common Crawl
// ---------------------------------------------------------------------------

async function runCommonCrawl(ctx: Context) {
  const index = String(ctx.run.params.index);
  const startPage = Number(ctx.run.params.startPage ?? 0);
  const pageCount = Number(ctx.run.params.pageCount ?? 5);

  if (!(await ctx.finishPendingWait())) return;
  if (ctx.stats.cursor === 0) {
    const count = await ctx.retrying(() => numPages(index), CC_PAGE_WAITS_MS, "Common Crawl dizini alınamadı", "Common Crawl yoğun, tekrar denenecek");
    if (count === null) return;
    if ("error" in count) {
      return ctx.stop("failed", `Common Crawl dizini alınamadı (${describeError(count.error)}). Sunucu yoğun olabilir; sonra "Devam ettir".`);
    }
    const pages = count.value;
    const available = Math.max(0, pages - startPage);
    ctx.stats.total = Math.min(pageCount, available);
    ctx.save();
    ctx.log(`${index}: toplam ${pages} sayfa; ${startPage}. sayfadan itibaren ${ctx.stats.total} sayfa taranacak.`);
    if (ctx.stats.total === 0) return;
  }

  while (ctx.stats.cursor < ctx.stats.total) {
    if (ctx.cancelled()) return;
    const page = startPage + ctx.stats.cursor;
    const fetched = await ctx.retrying(() => pageHosts(index, page), CC_PAGE_WAITS_MS, `Common Crawl ${page}. sayfa alınamadı`, "Common Crawl yoğun, tekrar denenecek");
    if (fetched === null) return;
    if ("error" in fetched) {
      return ctx.stop("failed", `Common Crawl ${page}. sayfa alınamadı (${describeError(fetched.error)}). Sunucu yoğun olabilir; sonra "Devam ettir".`);
    }
    const hosts = fetched.value;
    const before = ctx.stats.added;
    await ctx.ingest(hosts, { concurrency: 10 });
    ctx.stats.cursor++;
    ctx.save();
    saveNextPage(index, page + 1);
    ctx.log(`Sayfa ${page}: ${hosts.length} mağaza tarandı, ${ctx.stats.added - before} yeni eklendi.`);
  }
}

// ---------------------------------------------------------------------------
// Kaynak 3: Alan adı listesi (DNS)
// ---------------------------------------------------------------------------

async function runDns(ctx: Context) {
  await dnsSweep(ctx, (ctx.run.params.domains as string[]) ?? []);
}

/**
 * Alan adlarını sırayla DNS ile süzer (Shopify'a bağlı olanlar → ingest). Listede olanlara DNS sorulmaz.
 * İmleç her partide kaydedilir; yarıda kalırsa oradan sürer.
 */
async function dnsSweep(ctx: Context, domains: string[], opts: { batch?: number; concurrency?: number; logEvery?: number } = {}) {
  const BATCH = opts.batch ?? 200;
  const CONCURRENCY = opts.concurrency ?? 32;
  const LOG_EVERY = opts.logEvery ?? 1000;
  ctx.stats.total = domains.length;
  let nextLog = ctx.stats.cursor + LOG_EVERY;
  let sinceLog = { shopify: 0, added: ctx.stats.added };

  while (ctx.stats.cursor < domains.length) {
    if (ctx.cancelled()) return;
    const batch = domains.slice(ctx.stats.cursor, ctx.stats.cursor + BATCH);
    const fresh = batch.filter((d) => !storeExists(normalizeDomain(d) ?? d));
    ctx.stats.known += batch.length - fresh.length;

    const shopify: string[] = [];
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, fresh.length) }, async () => {
        while (i < fresh.length) {
          const d = fresh[i++];
          if (d.endsWith(".myshopify.com") || (await ctx.deps.isShopifyDns(d))) shopify.push(d);
        }
      }),
    );
    sinceLog.shopify += shopify.length;
    await ctx.ingest(shopify, { dnsChecked: true });
    ctx.stats.cursor += batch.length;
    ctx.save();

    if (ctx.stats.cursor >= nextLog || ctx.stats.cursor >= domains.length) {
      ctx.log(`${ctx.stats.cursor}/${domains.length} tarandı: ${sinceLog.shopify} Shopify (DNS), ${ctx.stats.added - sinceLog.added} yeni eklendi.`);
      nextLog = ctx.stats.cursor + LOG_EVERY;
      sinceLog = { shopify: 0, added: ctx.stats.added };
    }
  }
}

// ---------------------------------------------------------------------------
// Kaynak 4: Common Crawl alan adı listesi (.tr) + DNS
// ---------------------------------------------------------------------------

async function runCcDomains(ctx: Context) {
  const graph = String(ctx.run.params.graph);
  const tlds = (ctx.run.params.tlds as string[]) ?? ["tr"];
  const tldLabel = tlds.map((t) => `.${t}`).join(", ");

  if (!(await ctx.finishPendingWait())) return;
  let domains = readCachedList(graph, tlds);
  if (domains && ctx.stats.cursor === 0) ctx.log(`Daha önce indirilen liste kullanılıyor: ${domains.length} ${tldLabel} alan adı.`);
  if (!domains) {
    ctx.log(`${graph}: alan adı listesi indiriliyor (~1 GB akış; diske yalnızca ${tldLabel} kısmı yazılır)…`);
    let lastCheck = 0;
    let stop = false;
    const shouldStop = () => {
      const now = ctx.deps.now();
      if (now - lastCheck > 2000) {
        lastCheck = now;
        stop = ctx.cancelled();
      }
      return stop;
    };
    const onProgress = (p: ExtractProgress) => {
      const pct = p.totalBytes ? Math.round((p.bytes / p.totalBytes) * 100) : null;
      ctx.stats.note = `Liste indiriliyor${pct !== null ? `: %${pct}` : ` (${Math.round(p.bytes / 1e6)} MB)`} · ${p.found} ${tldLabel} alan adı bulundu`;
      ctx.save();
    };
    const res = await ctx.retrying(
      () => ctx.deps.extractDomains(graph, tlds, { onProgress, shouldStop }),
      CC_PAGE_WAITS_MS,
      "Alan adı listesi indirilemedi",
      "Common Crawl yoğun, tekrar denenecek",
    );
    ctx.stats.note = null;
    if (res === null) return;
    if ("error" in res) {
      return ctx.stop("failed", `Alan adı listesi indirilemedi (${describeError(res.error)}). Sonra "Devam ettir" ile tekrar deneyin.`);
    }
    if (res.value === null) return; // iptal
    domains = res.value;
    ctx.save();
    ctx.log(`${domains.length} ${tldLabel} alan adı bulundu; DNS ile Shopify kontrolü başlıyor.`);
  }
  await dnsSweep(ctx, domains, { logEvery: 5000 });
}

// ---------------------------------------------------------------------------
// Kaynak 5: Tranco (popüler 1 milyon site) + DNS
// ---------------------------------------------------------------------------

async function runTranco(ctx: Context) {
  const listId = String(ctx.run.params.listId);
  const start = Number(ctx.run.params.start ?? 0);
  const limit = Number(ctx.run.params.limit ?? 100_000);

  const res = await ctx.retrying(() => ctx.deps.trancoList(listId), ERROR_WAITS_MS, "Tranco listesi indirilemedi", "Bağlantı hatası, tekrar denenecek");
  if (res === null) return;
  if ("error" in res) {
    return ctx.stop("failed", `Tranco listesi indirilemedi (${describeError(res.error)}). Sonra "Devam ettir" ile tekrar deneyin.`);
  }
  const slice = res.value.slice(start, start + limit);
  if (ctx.stats.cursor === 0) ctx.log(`Tranco ${listId}: ${start + 1}–${start + slice.length}. sıradaki ${slice.length} site DNS ile kontrol edilecek.`);
  await dnsSweep(ctx, slice, { logEvery: 5000 });
}

// ---------------------------------------------------------------------------
// Kaynak 6: Wayback Machine (*.myshopify.com arşivi)
// ---------------------------------------------------------------------------

/** archive.org'a nazik olmak için sayfa istekleri arası bekleme */
const WAYBACK_GAP_MS: [number, number] = [4_000, 8_000];

async function runWayback(ctx: Context) {
  const startPage = Number(ctx.run.params.startPage ?? 0);
  const pageCount = Number(ctx.run.params.pageCount ?? 20);

  if (!(await ctx.finishPendingWait())) return;
  if (ctx.stats.cursor === 0) {
    const count = await ctx.retrying(() => ctx.deps.waybackPages(), ERROR_WAITS_MS, "Wayback dizinine ulaşılamadı", "Wayback yoğun, tekrar denenecek");
    if (count === null) return;
    if ("error" in count) {
      return ctx.stop("failed", `Wayback dizinine ulaşılamadı (${describeError(count.error)}). Sonra "Devam ettir".`);
    }
    ctx.stats.total = Math.min(pageCount, Math.max(0, count.value - startPage));
    ctx.save();
    ctx.log(`Wayback: toplam ${count.value} sayfa; ${startPage}. sayfadan itibaren ${ctx.stats.total} sayfa taranacak.`);
    if (ctx.stats.total === 0) return;
  }

  while (ctx.stats.cursor < ctx.stats.total) {
    if (ctx.cancelled()) return;
    const page = startPage + ctx.stats.cursor;
    const fetched = await ctx.retrying(
      () => ctx.deps.waybackHosts(page),
      [60_000, 3 * 60_000, 10 * 60_000],
      `Wayback ${page}. sayfa alınamadı`,
      "Wayback yoğun, tekrar denenecek",
    );
    if (fetched === null) return;
    if ("error" in fetched) {
      return ctx.stop("failed", `Wayback ${page}. sayfa alınamadı (${describeError(fetched.error)}). Sunucu yoğun olabilir; sonra "Devam ettir".`);
    }
    const hosts = fetched.value;
    const before = ctx.stats.added;
    await ctx.ingest(hosts, { concurrency: 8 });
    ctx.stats.cursor++;
    ctx.save();
    saveWaybackNextPage(page + 1);
    ctx.log(`Sayfa ${page}: ${hosts.length} mağaza tarandı, ${ctx.stats.added - before} yeni eklendi.`);
    if (ctx.stats.cursor < ctx.stats.total && !(await ctx.wait(jitter(...WAYBACK_GAP_MS)))) return;
  }
}
