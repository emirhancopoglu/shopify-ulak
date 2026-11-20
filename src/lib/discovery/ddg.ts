/**
 * DuckDuckGo HTML araması (ücretsiz, anahtarsız).
 * Testlerde görülen davranış (2026-11):
 *  - İlk sayfa 10 sonuç verir; "sonraki sayfa" isteklerini bot sayıp 202 ile reddeder → sorgu başına 10 sonuç.
 *  - Sık sorguda 202 (geçici engel) döner; bekleyip tekrar denemek gerekir.
 *  - inurl: gibi operatörler daha çabuk engellenir; "site:myshopify.com <kelime>" iyi çalışır.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Dikkat: "*.myshopify.com" mağazalarını değil, yalnızca kök "myshopify.com"u ele
const IGNORE_HOSTS = /(^|\.)(duckduckgo\.com|shopify\.com|shopify\.dev|wikipedia\.org|youtube\.com|facebook\.com|instagram\.com|linkedin\.com|reddit\.com)$|^myshopify\.com$/i;

export type SearchResult = { blocked: boolean; hosts: string[] };

export async function ddgSearch(query: string): Promise<SearchResult> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=tr-tr`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, "accept-language": "tr-TR,tr;q=0.9,en;q=0.5" },
    signal: AbortSignal.timeout(25_000),
  });
  const html = await res.text();
  if (res.status === 202 || res.status === 429 || /anomaly-modal|captcha/i.test(html)) return { blocked: true, hosts: [] };
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);

  const hosts = new Set<string>();
  for (const m of html.matchAll(/uddg=([^&"]+)/g)) {
    try {
      const host = new URL(decodeURIComponent(m[1])).hostname.toLowerCase().replace(/^www\./, "");
      if (host && !IGNORE_HOSTS.test(host)) hosts.add(host);
    } catch {
      /* bozuk link */
    }
  }
  return { blocked: false, hosts: [...hosts] };
}

/** Kategori kelimeleri × varyasyonlar → arama sorguları. "site:" içeren satırlar olduğu gibi kullanılır. */
export function buildQueries(keywords: string[], variations: string[]): string[] {
  const out = new Set<string>();
  for (const raw of keywords) {
    const kw = raw.trim();
    if (!kw) continue;
    if (/\bsite:/i.test(kw)) {
      out.add(kw);
      continue;
    }
    for (const v of variations.length ? variations : [""]) out.add(`site:myshopify.com ${kw} ${v}`.trim());
  }
  return [...out];
}

export const DEFAULT_KEYWORDS = [
  "kozmetik",
  "cilt bakım",
  "parfüm",
  "makyaj",
  "saç bakım",
  "takı",
  "gümüş takı",
  "saat",
  "aksesuar",
  "çanta",
  "ayakkabı",
  "kadın giyim",
  "elbise",
  "tesettür",
  "erkek giyim",
  "çocuk giyim",
  "bebek",
  "iç giyim",
  "spor giyim",
  "ev dekorasyon",
  "kokulu mum", // yalın "mum" İngilizcede "anne" demek; yabancı mağaza getiriyor
  "ev tekstili",
  "mutfak",
  "kahve",
  "çay",
  "organik gıda",
  "evcil hayvan",
  "oyuncak",
  "el yapımı",
  "seramik",
  "mobilya",
  "telefon kılıfı",
  "outdoor kamp",
  "hediye",
];

export const VARIATIONS = [
  { value: "", label: "Yalın" },
  { value: "türkiye", label: "+ türkiye" },
  { value: "tl", label: "+ tl" },
  { value: "kargo", label: "+ kargo" },
  { value: "indirim", label: "+ indirim" },
];
