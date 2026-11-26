// Saf yardımcılar (DB ve ağ yok): genel site keşfinde hedef dışı site türlerini tanır.
//
// Hedef: kendi sitesini yeniletmeye ihtiyaç duyabilecek küçük ve orta işletmeler. Haber siteleri, avukat/hukuk büroları
// ve kamu kurumları (belediye, valilik, üniversite…) hedef değildir; bunlar keşfe girmemeli.

export type SiteSegment = "news" | "legal" | "public";

export const SEGMENT_LABEL: Record<SiteSegment, string> = {
  news: "Haber",
  legal: "Avukat / hukuk",
  public: "Kamu",
};

const tr = (s: string) => s.toLocaleLowerCase("tr");

/** Alan adındaki anahtar kelimeler (alt dize). Yanlış pozitifi düşük kelimeler seçildi. */
const DOMAIN_PATTERNS: [SiteSegment, RegExp][] = [
  ["news", /haber|gazete|sondakika|manset|newspaper|\bnews\b|[a-z]news\b|gundem/],
  ["legal", /avukat|hukuk|lawfirm|lawyer|attorney|(^|[.-])noter/],
  ["public", /belediye|valilik|kaymakamlik|muhtarlik|bakanlik|tbmm|rektorlik/],
];

/** Başlık / site adı / açıklamadaki ifadeler (Türkçe küçük harfe çevrilmiş metinde). */
const TEXT_PATTERNS: [SiteSegment, RegExp][] = [
  ["news", /\b(haber|haberi|haberleri|haberler|gazetesi|gazete|son dakika|newspaper)\b|\bnews\b/],
  ["legal", /avukat|hukuk|\blaw (firm|office)\b|attorney|\bnoter/],
  ["public", /belediye|valiliği|kaymakamlığı|müdürlüğü|başkanlığı|bakanlığı|rektörlüğü|muhtarlığı|\bt\.c\.\s|üniversitesi|il özel idare/],
];

const JSON_LD_NEWS = /"@type"\s*:\s*\[?\s*"(NewsMediaOrganization|NewsArticle|ReportageNewsArticle)"/i;

/** Yalnızca alan adından (ağ isteğinden önce, ucuz): açık anahtar kelime varsa tür döner. */
export function segmentFromDomain(host: string): SiteSegment | null {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/ı/g, "i");
  for (const [segment, re] of DOMAIN_PATTERNS) if (re.test(h)) return segment;
  return null;
}

export type HomepageHints = { title: string | null; siteName: string | null; html: string };

function pick(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m?.[1] ? m[1].replace(/\s+/g, " ").trim() : null;
}

/** Ana sayfa HTML'inden başlık ve site adı (regex: sıcak yolda cheerio'dan hızlı). */
export function homepageHints(html: string): HomepageHints {
  const title = pick(html, /<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const siteName =
    pick(html, /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']{0,200})["']/i) ??
    pick(html, /<meta[^>]+content=["']([^"']{0,200})["'][^>]*property=["']og:site_name["']/i);
  return { title, siteName, html };
}

/**
 * Ana sayfa içeriğinden tür (başlık + site adı + JSON-LD). Açıklama metni bilerek kullanılmaz: "hukuk" ya da "haber"
 * kelimesi, örneğin bir e-ticaret sitesinin açıklamasında geçebilir.
 */
export function segmentFromHomepage(hints: HomepageHints): SiteSegment | null {
  if (JSON_LD_NEWS.test(hints.html)) return "news";
  const text = tr(`${hints.title ?? ""} | ${hints.siteName ?? ""}`);
  for (const [segment, re] of TEXT_PATTERNS) if (re.test(text)) return segment;
  return null;
}

/** Kayıtlı bir site (alan adı, marka, başlık) için aynı kural; eski kayıtları temizlemekte kullanılır. */
export function segmentForStoredSite(site: { domain: string; brandName: string | null; title?: string | null }): SiteSegment | null {
  return segmentFromDomain(site.domain) ?? segmentFromHomepage({ title: site.title ?? null, siteName: site.brandName, html: "" });
}
