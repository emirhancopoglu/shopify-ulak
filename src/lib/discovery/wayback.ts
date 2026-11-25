import { getSetting, setSetting } from "@/lib/settings";

/**
 * Internet Archive (Wayback Machine) CDX dizini: arşivlenmiş *.myshopify.com adresleri.
 * Ücretsiz ama yavaş (sayfa başına 10-60 sn) ve sayfa başına mağaza sayısı çok değişken (1-200).
 * Global arşiv: Türk oranı %1'in altında, TR filtresiyle kullanılır. İstekler arası bekleme runner'da.
 */
const BASE = "https://web.archive.org/cdx/search/cdx?url=myshopify.com&matchType=domain";

async function get(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(150_000), headers: { "User-Agent": "Mozilla/5.0 (local research tool)" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(res.status === 429 ? "Wayback çok sık istek uyarısı verdi (429)" : `Wayback HTTP ${res.status}`);
  }
  return res.text();
}

/** Önbellekteki sayfa sayısı (sayfa yüklenirken ağa gitmemek için); yoksa null. */
export function cachedWaybackPageCount(): number | null {
  const cached = getSetting("wayback_pages");
  return cached ? (JSON.parse(cached) as { pages: number }).pages : null;
}

/** Toplam sayfa sayısı (1 gün önbellekli). */
export async function waybackPageCount(): Promise<number> {
  const cached = getSetting("wayback_pages");
  if (cached) {
    const { at, pages } = JSON.parse(cached) as { at: number; pages: number };
    if (Date.now() - at < 86_400_000 && pages > 0) return pages;
  }
  const pages = Number((await get(`${BASE}&showNumPages=true`)).trim());
  if (!Number.isFinite(pages) || pages <= 0) throw new Error("Wayback sayfa sayısı okunamadı");
  setSetting("wayback_pages", JSON.stringify({ at: Date.now(), pages }));
  return pages;
}

/** `com,myshopify,magaza)/yol` → `magaza.myshopify.com` */
export function hostFromUrlkey(urlkey: string): string | null {
  const parts = urlkey.split(")")[0].replace(/:\d+$/, "").split(",");
  if (parts[0] !== "com" || parts[1] !== "myshopify" || parts.length < 3) return null;
  const host = [...parts.slice(2)].reverse().join(".");
  if (!host || host === "www" || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return null;
  return `${host}.myshopify.com`;
}

export async function waybackPageHosts(page: number): Promise<string[]> {
  const text = await get(`${BASE}&fl=urlkey&collapse=urlkey&page=${page}`);
  const hosts = new Set<string>();
  for (const line of text.split("\n")) {
    const host = hostFromUrlkey(line.trim());
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/** En son kalınan sayfa (sonraki çalıştırma oradan başlasın). */
export const waybackNextPage = () => Number(getSetting("wayback_next_page") ?? 0);
export const saveWaybackNextPage = (page: number) => setSetting("wayback_next_page", String(page));
