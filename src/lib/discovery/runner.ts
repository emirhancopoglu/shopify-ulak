import { db } from "@/db";
import type { DiscoveryRun, DiscoveryStats } from "@/db/schema";
import { describeError } from "@/lib/analyzer/http";
import { normalizeDomain } from "@/lib/domains";
import { addStores } from "@/lib/stores";
import { numPages, pageHosts, saveNextPage } from "./commoncrawl";
import { ddgSearch } from "./ddg";
import { looksLikeShopify } from "./dns";
import { isTurkish, probeStore } from "./probe";
import { appendLog, getRun, isCancelled, saveStats, setRunStatus } from "./runs";

/**
 * Keşif çalıştırması (worker'daki "discover" işi). Kaldığı yeri stats.cursor'da tutar:
 * worker yeniden başlarsa ya da kullanıcı "devam ettir" derse oradan sürer.
 * Hata fırlatmaz (iş kuyruğu otomatik tekrar denemesin); durumu kendisi yazar.
 */
export async function runDiscovery(runId: number) {
  const run = getRun(runId);
  if (!run || run.status === "cancelled" || run.status === "done") return;
  setRunStatus(runId, "running");
  const ctx = new Context(run);
  try {
    if (run.source === "search") await runSearch(ctx);
    else if (run.source === "commoncrawl") await runCommonCrawl(ctx);
    else if (run.source === "dns") await runDns(ctx);
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

const SOURCE_TAG: Record<DiscoveryRun["source"], string> = { search: "search", commoncrawl: "commoncrawl", dns: "dns" };

class Context {
  stats: DiscoveryStats;
  stopped = false;
  private seen = new Set<string>();

  constructor(readonly run: DiscoveryRun) {
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
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.cancelled()) return false;
      await new Promise((r) => setTimeout(r, Math.min(2000, end - Date.now())));
    }
    return true;
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

// ---------------------------------------------------------------------------
// Kaynak 1: DuckDuckGo araması
// ---------------------------------------------------------------------------

async function runSearch(ctx: Context) {
  const queries = (ctx.run.params.queries as string[]) ?? [];
  ctx.stats.total = queries.length;
  let blockedInARow = 0;

  while (ctx.stats.cursor < queries.length) {
    if (ctx.cancelled()) return;
    const q = queries[ctx.stats.cursor];
    const res = await ddgSearch(q);

    if (res.blocked) {
      blockedInARow++;
      if (blockedInARow >= 3) {
        return ctx.stop(
          "blocked",
          `DuckDuckGo geçici olarak engelledi (${ctx.stats.cursor}/${queries.length} sorgu tamamlandı). 20-30 dk sonra "Devam ettir" ile kaldığı yerden sürdürün.`,
        );
      }
      const pause = blockedInARow * 120_000;
      ctx.log(`DuckDuckGo yavaşlattı; ${pause / 60_000} dk bekleniyor…`);
      if (!(await ctx.wait(pause))) return;
      continue; // aynı sorguyu tekrar dene
    }
    blockedInARow = 0;

    const before = ctx.stats.added;
    await ctx.ingest(res.hosts);
    ctx.stats.cursor++;
    ctx.save();
    ctx.log(`"${q}" → ${res.hosts.length} sonuç, ${ctx.stats.added - before} yeni mağaza`);

    if (ctx.stats.cursor < queries.length && !(await ctx.wait(jitter(10_000, 16_000)))) return;
  }
}

// ---------------------------------------------------------------------------
// Kaynak 2: Common Crawl
// ---------------------------------------------------------------------------

async function runCommonCrawl(ctx: Context) {
  const index = String(ctx.run.params.index);
  const startPage = Number(ctx.run.params.startPage ?? 0);
  const pageCount = Number(ctx.run.params.pageCount ?? 5);

  if (ctx.stats.cursor === 0) {
    const pages = await numPages(index);
    const available = Math.max(0, pages - startPage);
    ctx.stats.total = Math.min(pageCount, available);
    ctx.save();
    ctx.log(`${index}: toplam ${pages} sayfa; ${startPage}. sayfadan itibaren ${ctx.stats.total} sayfa taranacak.`);
    if (ctx.stats.total === 0) return;
  }

  while (ctx.stats.cursor < ctx.stats.total) {
    if (ctx.cancelled()) return;
    const page = startPage + ctx.stats.cursor;
    let hosts: string[];
    try {
      hosts = await pageHosts(index, page);
    } catch (err) {
      return ctx.stop("failed", `Common Crawl ${page}. sayfa alınamadı (${describeError(err)}). Sunucu yoğun olabilir; sonra "Devam ettir".`);
    }
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
  const domains = (ctx.run.params.domains as string[]) ?? [];
  ctx.stats.total = domains.length;
  const BATCH = 25;

  while (ctx.stats.cursor < domains.length) {
    if (ctx.cancelled()) return;
    const batch = domains.slice(ctx.stats.cursor, ctx.stats.cursor + BATCH);
    const checks = await Promise.all(batch.map(async (d) => ((await looksLikeShopify(d)) ? d : null)));
    const shopify = checks.filter((d): d is string => Boolean(d));
    const before = ctx.stats.added;
    await ctx.ingest(shopify, { dnsChecked: true });
    ctx.stats.cursor += batch.length;
    ctx.save();
    if (shopify.length) ctx.log(`${ctx.stats.cursor}/${domains.length}: ${shopify.length} Shopify (DNS), ${ctx.stats.added - before} yeni eklendi.`);
  }
}
