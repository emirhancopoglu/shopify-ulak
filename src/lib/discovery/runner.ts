import { db } from "@/db";
import type { DiscoveryRun, DiscoveryStats } from "@/db/schema";
import { describeError } from "@/lib/analyzer/http";
import { normalizeDomain } from "@/lib/domains";
import { addStores } from "@/lib/stores";
import { numPages, pageHosts, saveNextPage } from "./commoncrawl";
import { ddgSearch } from "./ddg";
import { isExcludedSuffix, seededShuffle } from "./domain-order";
import { segmentFromDomain } from "./segments";
import { extractTldDomains, readCachedList, type ExtractProgress } from "./domainlist";
import { popularDomains, trancoDomains } from "./tranco";
import { saveWaybackNextPage, waybackPageCount, waybackPageHosts } from "./wayback";
import { hasARecord, looksLikeShopify } from "./dns";
import { probeSite, type GeneralProbe } from "./general-probe";
import { isTurkish, probeStore } from "./probe";
import { DEFAULT_GENERAL_PLATFORMS } from "@/lib/platform-labels";
import type { Platform } from "@/db/schema";
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
    else if (run.source === "general_ccdomains") await runGeneralCcDomains(ctx);
    else if (run.source === "general_tranco") {
      ctx.stop("failed", "Bu kaynak kaldırıldı: popüler siteler artık genel taramadan elenir. Alan adı arşivi (.tr) kaynağını kullanın.");
    }
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
  general_ccdomains: "general_ccdomains",
  general_tranco: "general_tranco",
};

/** Testlerde ağ ve saat yerine sahte sürümler verilebilsin diye. */
export type RunnerDeps = {
  search: typeof ddgSearch;
  isShopifyDns: typeof looksLikeShopify;
  extractDomains: typeof extractTldDomains;
  trancoList: (listId: string) => Promise<string[]>;
  waybackPages: () => Promise<number>;
  waybackHosts: (page: number) => Promise<string[]>;
  /** Genel siteler: alan adının IP kaydı var mı */
  hasDns: (domain: string) => Promise<boolean>;
  /** Genel siteler: ana sayfanın platformu */
  probeSite: (domain: string) => Promise<GeneralProbe>;
  /** Genel siteler: elenecek popüler siteler (Tranco ilk 1 milyon) */
  popularDomains: () => Promise<string[]>;
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
  hasDns: hasARecord,
  probeSite,
  popularDomains,
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
  const domains = await loadTrList(ctx);
  if (domains === null) return;
  await dnsSweep(ctx, domains, { logEvery: 5000 });
}

/** Common Crawl alan adı listesi (önbellek ya da ilk indirme). İptal ya da hatada null; durum zaten yazılmıştır. */
async function loadTrList(ctx: Context): Promise<string[] | null> {
  const graph = String(ctx.run.params.graph);
  const tlds = (ctx.run.params.tlds as string[]) ?? ["tr"];
  const tldLabel = tlds.map((t) => `.${t}`).join(", ");

  if (!(await ctx.finishPendingWait())) return null;
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
    if (res === null) return null;
    if ("error" in res) {
      ctx.stop("failed", `Alan adı listesi indirilemedi (${describeError(res.error)}). Sonra "Devam ettir" ile tekrar deneyin.`);
      return null;
    }
    if (res.value === null) return null; // iptal
    domains = res.value;
    ctx.save();
    ctx.log(`${domains.length} ${tldLabel} alan adı bulundu; DNS ile kontrol başlıyor.`);
  }
  return domains;
}

// ---------------------------------------------------------------------------
// Kaynak 5: Tranco (popüler 1 milyon site) + DNS
// ---------------------------------------------------------------------------

async function runTranco(ctx: Context) {
  const slice = await trancoSlice(ctx);
  if (slice === null) return;
  await dnsSweep(ctx, slice, { logEvery: 5000 });
}

/** Tranco listesinden çalıştırmanın dilimini alır. İptal ya da hatada null. */
async function trancoSlice(ctx: Context): Promise<string[] | null> {
  const listId = String(ctx.run.params.listId);
  const start = Number(ctx.run.params.start ?? 0);
  const limit = Number(ctx.run.params.limit ?? 100_000);

  const res = await ctx.retrying(() => ctx.deps.trancoList(listId), ERROR_WAITS_MS, "Tranco listesi indirilemedi", "Bağlantı hatası, tekrar denenecek");
  if (res === null) return null;
  if ("error" in res) {
    ctx.stop("failed", `Tranco listesi indirilemedi (${describeError(res.error)}). Sonra "Devam ettir" ile tekrar deneyin.`);
    return null;
  }
  const slice = res.value.slice(start, start + limit);
  if (ctx.stats.cursor === 0) ctx.log(`Tranco ${listId}: ${start + 1}–${start + slice.length}. sıradaki ${slice.length} site kontrol edilecek.`);
  return slice;
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

// ---------------------------------------------------------------------------
// Genel siteler (F6 Faz 3): alan adı → DNS → ana sayfa platformu → seçili platformlar eklenir
// ---------------------------------------------------------------------------

/** Genel kaynakların DNS ve HTTP eşzamanlılığı. HTTP tarafı nazik kalsın diye düşük. */
const GENERAL_DNS_CONCURRENCY = 32;
const GENERAL_PROBE_CONCURRENCY = 12;
const GENERAL_BATCH = 200;

async function runGeneralCcDomains(ctx: Context) {
  const domains = await loadTrList(ctx);
  if (domains === null) return;
  const popular = await loadPopular(ctx);
  if (popular === null) return;
  // Liste alfabetik; sıralı dilimler tek uzantı bloğuna (.av.tr, .bel.tr…) takılıyordu. Hedef dışı uzantılar elenir,
  // kalan liste graph kimliğiyle sabit tohumdan karıştırılır (aynı dilim hep aynı siteleri verir, devam ettirme bozulmaz).
  // Popüler siteler ve haber/avukat/kamu adları dilimden SONRA elenir: popülerlik listesi günlük değişir, sıra değişmemeli.
  const ordered = seededShuffle(
    domains.filter((d) => !isExcludedSuffix(d)),
    String(ctx.run.params.graph),
  );
  const start = Number(ctx.run.params.start ?? 0);
  const limit = Number(ctx.run.params.limit ?? ordered.length);
  const slice = ordered.slice(start, start + limit);
  if (ctx.stats.cursor === 0) {
    ctx.log(
      `${start + 1}–${start + slice.length}. sıradaki ${slice.length} alan adı genel site taramasından geçecek (karışık sıra; avukat/kamu uzantıları elendi: ${domains.length - ordered.length}; popüler site listesi: ${popular.size.toLocaleString("tr-TR")}).`,
    );
  }
  await generalSweep(ctx, slice, popular);
}

/** Popüler siteler (Tranco ilk 1 milyon). İptal ya da hatada null; durum zaten yazılmıştır. */
async function loadPopular(ctx: Context): Promise<Set<string> | null> {
  const res = await ctx.retrying(() => ctx.deps.popularDomains(), ERROR_WAITS_MS, "Popüler site listesi alınamadı", "Bağlantı hatası, tekrar denenecek");
  if (res === null) return null;
  if ("error" in res) {
    ctx.stop("failed", `Popüler site listesi (Tranco) alınamadı (${describeError(res.error)}). Sonra "Devam ettir" ile tekrar deneyin.`);
    return null;
  }
  return new Set(res.value.map((d) => d.toLowerCase()));
}

/** Havuz: `items` üzerinde en fazla `size` eşzamanlı `fn` çalıştırır. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/**
 * Alan adlarını genel site olarak süzer. Sırası: Türkiye filtresi (.tr) → zaten listede → DNS (IP kaydı) →
 * ana sayfa (platform, Shopify değil, seçili platformlardan biri). Eşleşenler mağaza kuyruğuna (analiz) eklenir.
 * İmleç her partide kaydedilir; yarıda kalırsa oradan sürer.
 */
async function generalSweep(ctx: Context, domains: string[], popular: Set<string>) {
  const wanted = new Set<Platform>((ctx.run.params.platforms as Platform[] | undefined) ?? DEFAULT_GENERAL_PLATFORMS);
  const LOG_EVERY = 2000;
  ctx.stats.total = domains.length;
  ctx.stats.dead = ctx.stats.dead ?? 0;
  let nextLog = ctx.stats.cursor + LOG_EVERY;
  let sinceLog = { added: ctx.stats.added, matched: ctx.stats.matched };

  while (ctx.stats.cursor < domains.length) {
    if (ctx.cancelled()) return;
    const batch = domains.slice(ctx.stats.cursor, ctx.stats.cursor + GENERAL_BATCH);

    // Hedef dışı elemeler (ağ isteğinden önce): avukat/kamu uzantısı, popüler site, alan adında haber/avukat/kamu kelimesi
    const hosts: string[] = [];
    for (const h of batch.map((d) => normalizeDomain(d) ?? d).filter((x) => !ctx.trOnly || x.endsWith(".tr"))) {
      if (isExcludedSuffix(h) || segmentFromDomain(h)) ctx.stats.excluded = (ctx.stats.excluded ?? 0) + 1;
      else if (popular.has(h)) ctx.stats.popular = (ctx.stats.popular ?? 0) + 1;
      else hosts.push(h);
    }
    const fresh: string[] = [];
    for (const h of hosts) {
      if (storeExists(h)) ctx.stats.known++;
      else fresh.push(h);
    }
    ctx.stats.candidates += fresh.length;

    // 1) DNS: IP kaydı olmayanlar (park edilmemiş, ölü) elenir
    const withDns: string[] = [];
    await pool(fresh, GENERAL_DNS_CONCURRENCY, async (h) => {
      try {
        if (await ctx.deps.hasDns(h)) withDns.push(h);
        else ctx.stats.dead = (ctx.stats.dead ?? 0) + 1;
      } catch {
        ctx.stats.dead = (ctx.stats.dead ?? 0) + 1;
      }
    });

    // 2) Ana sayfa: Shopify izi varsa atlanır (Shopify sekmesine ait), açılmıyorsa ölü, değilse platform filtresi
    const toAdd: string[] = [];
    await pool(withDns, GENERAL_PROBE_CONCURRENCY, async (h) => {
      let probe: GeneralProbe;
      try {
        probe = await ctx.deps.probeSite(h);
      } catch {
        ctx.stats.dead = (ctx.stats.dead ?? 0) + 1;
        return;
      }
      if (!probe.reachable) {
        ctx.stats.dead = (ctx.stats.dead ?? 0) + 1;
        return;
      }
      if (probe.shopify) {
        ctx.stats.shopify++;
        return;
      }
      // Ana sayfa başlığı/site adı/JSON-LD haber, avukat ya da kamu sitesi diyorsa hedef dışı
      if (probe.segment) {
        ctx.stats.excluded = (ctx.stats.excluded ?? 0) + 1;
        return;
      }
      if (!wanted.has(probe.platform)) return;
      ctx.stats.matched++;
      toAdd.push(h);
    });

    if (toAdd.length) {
      const { added } = addStores([...new Set(toAdd)], SOURCE_TAG[ctx.run.source]);
      ctx.stats.added += added;
    }

    ctx.stats.cursor += batch.length;
    ctx.save();

    if (ctx.stats.cursor >= nextLog || ctx.stats.cursor >= domains.length) {
      ctx.log(
        `${ctx.stats.cursor}/${domains.length} tarandı: ${ctx.stats.matched - sinceLog.matched} platform eşleşti, ${ctx.stats.added - sinceLog.added} yeni eklendi.`,
      );
      nextLog = ctx.stats.cursor + LOG_EVERY;
      sinceLog = { added: ctx.stats.added, matched: ctx.stats.matched };
    }
  }
}
