import { getSetting, setSetting } from "@/lib/settings";

/**
 * Common Crawl CDX dizini (ücretsiz). *.myshopify.com adreslerini sayfa sayfa listeler.
 * Sunucu sık 504 verir: küçük sayfa (pageSize=1, ~600 satır, ~100 mağaza) + geri çekilmeli tekrar deneme.
 * Uyarı: global bir arşiv; Türk mağazası oranı %1'in altında, bu yüzden TR filtresiyle kullanılır.
 */
const BASE = "https://index.commoncrawl.org";
const PATTERN = "*.myshopify.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (res.ok) return res;
      lastErr = new Error(`Common Crawl HTTP ${res.status}`);
      await res.body?.cancel();
      if (res.status < 500 && res.status !== 429) break; // kalıcı hata
    } catch (err) {
      lastErr = err;
    }
    await sleep([5_000, 15_000, 30_000, 60_000][i] ?? 60_000);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export type CrawlIndex = { id: string; name: string };

/** Dizin listesi (1 gün önbellekli). */
export async function listIndexes(): Promise<CrawlIndex[]> {
  const cached = getSetting("cc_indexes");
  if (cached) {
    const { at, items } = JSON.parse(cached) as { at: number; items: CrawlIndex[] };
    if (Date.now() - at < 86_400_000 && items.length) return items;
  }
  const res = await fetchWithRetry(`${BASE}/collinfo.json`, 2);
  const items = ((await res.json()) as { id: string; name: string }[]).map((x) => ({ id: x.id, name: x.name }));
  setSetting("cc_indexes", JSON.stringify({ at: Date.now(), items }));
  return items;
}

export async function numPages(index: string): Promise<number> {
  const res = await fetchWithRetry(`${BASE}/${index}-index?url=${PATTERN}&output=json&showNumPages=true&pageSize=1`);
  return ((await res.json()) as { pages: number }).pages;
}

export async function pageHosts(index: string, page: number): Promise<string[]> {
  const res = await fetchWithRetry(`${BASE}/${index}-index?url=${PATTERN}&output=json&fl=url&pageSize=1&page=${page}`);
  const hosts = new Set<string>();
  for (const line of (await res.text()).split("\n")) {
    try {
      const host = new URL((JSON.parse(line) as { url: string }).url).hostname.toLowerCase();
      if (host.endsWith(".myshopify.com") && host !== "www.myshopify.com") hosts.add(host);
    } catch {
      /* boş/bozuk satır */
    }
  }
  return [...hosts];
}

/** Bir dizinde en son nerede kalındığı (sonraki çalıştırma oradan başlasın). */
export const nextPageFor = (index: string) => Number(getSetting(`cc_next_page:${index}`) ?? 0);
export const saveNextPage = (index: string, page: number) => setSetting(`cc_next_page:${index}`, String(page));
