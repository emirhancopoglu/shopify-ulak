import type { CheerioAPI } from "cheerio";
import { fetchPage } from "./http";
import { detectApps, findContactLinks, parseTheme, type ShopifyProduct } from "./storefront";

/**
 * Mağaza eksikleri (bulgular). Sadece ücretsiz kaynaklardan (mağazanın kendi HTML'i ve Shopify endpoint'leri) çıkarılır.
 * Bir kontrol "bilinmiyor" dönerse (ağ hatası, veri yok) bulgu üretilmez; yanlış suçlama yapmamak için.
 */
export type FindingKey = "broken_links" | "old_theme" | "no_reviews" | "missing_alt" | "no_contact" | "no_mobile_meta";

export type Finding = {
  key: FindingKey;
  /** Arayüzde kısa etiket (Türkçe). */
  label: string;
  /** Ayrıntı (Türkçe, arayüz için). */
  detail: string;
  /** E-postada {{bulgu}} olarak kullanılan, nazik ve tek cümlelik ifade. */
  sentence: string;
};

/** E-postada en fazla bir bulgu kullanılır; öncelik sırası bu dizidir. */
export const FINDING_PRIORITY: FindingKey[] = ["broken_links", "old_theme", "no_reviews", "missing_alt", "no_contact", "no_mobile_meta"];

/** Yorum uygulamaları (detectApps adlarıyla birebir). */
export const REVIEW_APPS = ["Judge.me", "Yotpo", "Loox", "Okendo", "Stamped"];

/** Online Store 2.0 öncesi, artık eski kabul edilen Shopify temaları (isim başlangıcıyla eşleşir). */
export const LEGACY_THEMES = ["Debut", "Brooklyn", "Venture", "Narrative", "Simple", "Supply", "Boundless", "Parallax", "Pop", "Minimal", "Vantage"];

const MIN_IMAGE_SAMPLE = 5;

/** Ana menü / üst bölümdeki aynı siteye ait bağlantılar (kırık link kontrolü için). */
export function internalNavLinks($: CheerioAPI, baseUrl: string, limit = 10): string[] {
  const base = new URL(baseUrl);
  const out = new Set<string>();
  const skipPath = /^\/(cart|account|search|checkout|password|policies)(\/|$)/i;
  $("header a[href], nav a[href], .header a[href], .site-nav a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      const u = new URL(href, base);
      if (u.host !== base.host || u.pathname === "/" || skipPath.test(u.pathname)) return;
      out.add(`${u.origin}${u.pathname}`);
    } catch {
      /* geçersiz link */
    }
  });
  return [...out].slice(0, limit);
}

/** Verilen adreslerden 404/410 dönenleri bulur. Diğer hatalar (zaman aşımı vb.) "kırık" sayılmaz. */
export async function findBrokenLinks(urls: string[]): Promise<string[]> {
  const broken: string[] = [];
  for (let i = 0; i < urls.length; i += 2) {
    const batch = urls.slice(i, i + 2); // nazik olmak için en fazla 2 eşzamanlı istek
    const results = await Promise.all(
      batch.map(async (u) => {
        try {
          const page = await fetchPage(u, { timeoutMs: 10_000 });
          return page.status === 404 || page.status === 410 ? u : null;
        } catch {
          return null;
        }
      }),
    );
    broken.push(...results.filter((u): u is string => u !== null));
  }
  return broken;
}

export function brokenLinksFinding(brokenUrls: string[]): Finding | null {
  if (brokenUrls.length === 0) return null;
  const paths = brokenUrls.map((u) => new URL(u).pathname);
  return {
    key: "broken_links",
    label: `${brokenUrls.length} kırık menü bağlantısı`,
    detail: `Açılmayan sayfalar: ${paths.join(", ")}`,
    sentence: "Sitenizin menüsünde açılmayan bağlantılar var; ziyaretçiler bu sayfalara ulaşamıyor olabilir.",
  };
}

/** Eski tema adı veya Online Store 2.0 bölüm yapısının olmaması. Tema bilgisi yoksa bulgu üretilmez. */
export function themeFinding(themeName: string | null, hasSections: boolean): Finding | null {
  if (!themeName) return null;
  const legacy = LEGACY_THEMES.find((t) => new RegExp(`^${t}\\b`, "i").test(themeName));
  if (legacy) {
    return {
      key: "old_theme",
      label: `Eski tema: ${themeName}`,
      detail: `${themeName} teması artık eski kabul ediliyor`,
      sentence: `Mağazanızdaki "${themeName}" teması eski bir yapıda görünüyor; bölümlerin ve mobil görünümün güncellenmesi faydalı olabilir.`,
    };
  }
  if (!hasSections) {
    return {
      key: "old_theme",
      label: "Eski tema yapısı",
      detail: "Sayfada Online Store 2.0 bölümleri (shopify-section) bulunamadı",
      sentence: "Mağazanızın teması eski bir yapıda görünüyor; bölümleri yeniden düzenlemek zor olabilir.",
    };
  }
  return null;
}

/** Genel yorum izleri: yapısal veri (aggregateRating), review sınıf/kimlikleri, bilinen yorum sağlayıcıları. */
const REVIEW_MARKERS = /aggregateRating|ratingValue|class="[^"]*\breview|id="[^"]*review|data-review|jdgm-|yotpo|stamped|okendo|bazaarvoice|loox/i;

/**
 * Ürün sayfasında yorum yoksa bulgu. Bilinen bir uygulama adı VEYA genel yorum izi varsa bulgu üretilmez
 * (bilinmeyen/özel yorum sistemleri yanlış suçlama olmasın diye).
 */
export function reviewFinding(appsFound: string[], productHtml: string): Finding | null {
  if (appsFound.some((a) => REVIEW_APPS.includes(a))) return null;
  if (REVIEW_MARKERS.test(productHtml)) return null;
  return {
    key: "no_reviews",
    label: "Yorum uygulaması yok",
    detail: "Ürün sayfasında bilinen bir yorum uygulaması (Judge.me, Yotpo, Loox, Okendo, Stamped) bulunamadı",
    sentence: "Ürün sayfalarınızda müşteri yorumlarını gösteren bir alan görünmüyor; yorumlar güven oluşturmada önemli.",
  };
}

/** Ürün görsellerinin çoğunda alt metin yoksa bulgu. "alt" alanı hiç yoksa bilinmiyor sayılır. */
export function altFinding(products: ShopifyProduct[]): Finding | null {
  const firstImages = products.map((p) => p.images?.[0]).filter((img): img is NonNullable<typeof img> => Boolean(img));
  if (firstImages.length < MIN_IMAGE_SAMPLE || !firstImages.some((img) => "alt" in img)) return null;
  const missing = firstImages.filter((img) => !(img.alt ?? "").trim()).length;
  if (missing / firstImages.length < 0.5) return null;
  return {
    key: "missing_alt",
    label: `${missing}/${firstImages.length} üründe görsel alt metni yok`,
    detail: "Ürün görsellerinin ilk fotoğraflarında alt metin boş",
    sentence: "Ürün görsellerinin çoğunda alt metin eksik görünüyor; bu hem arama sonuçlarında hem ekran okuyucularda ürünlerin anlaşılmasını zorlaştırıyor.",
  };
}

/** Ayrı bir iletişim sayfası yoksa bulgu. */
export function contactFinding(hasContactPage: boolean): Finding | null {
  if (hasContactPage) return null;
  return {
    key: "no_contact",
    label: "İletişim sayfası yok",
    detail: "İletişim veya bize ulaşın sayfası bulunamadı",
    sentence: "Sitenizde ayrı bir iletişim sayfası görünmüyor; müşterilerin size ulaşması için görünür bir kanal eklenebilir.",
  };
}

/** Viewport etiketi yoksa bulgu (mobil görünüm için temel). */
export function viewportFinding($: CheerioAPI): Finding | null {
  if ($('meta[name="viewport"]').length > 0) return null;
  return {
    key: "no_mobile_meta",
    label: "Viewport etiketi yok",
    detail: 'Sayfada <meta name="viewport"> etiketi bulunamadı',
    sentence: "Sitenizin mobil görünüm ayarında eksik bir etiket var; telefonda sayfa küçük görünebilir.",
  };
}

/** Sıralı, aynı anahtardan en fazla bir bulgu içeren liste. */
export function sortFindings(findings: (Finding | null)[]): Finding[] {
  const present = findings.filter((f): f is Finding => f !== null);
  return present.sort((a, b) => FINDING_PRIORITY.indexOf(a.key) - FINDING_PRIORITY.indexOf(b.key));
}

async function fetchOk(url: string): Promise<boolean> {
  try {
    const page = await fetchPage(url, { timeoutMs: 10_000 });
    return page.ok && (page.headers.get("content-type") ?? "").includes("html");
  } catch {
    return false;
  }
}

/** Ana sayfa + bir ürün sayfası + birkaç ek istekle tüm bulguları toplar. Şifreli mağazalarda çağrılmamalı. */
export async function analyzeFindings(input: {
  origin: string;
  finalUrl: string;
  $: CheerioAPI;
  html: string;
  products: ShopifyProduct[];
}): Promise<Finding[]> {
  const { origin, finalUrl, $, html, products } = input;

  const firstWithHandle = products.find((p) => p.handle);
  // Yorum uygulaması genelde ürün sayfasında yüklenir; ürün sayfası alınamazsa o kontrol atlanır
  const productHtml = firstWithHandle ? await fetchPageHtml(`${origin}/products/${firstWithHandle.handle}`) : null;
  const apps = [...new Set([...detectApps(html), ...detectApps(productHtml ?? "")])];

  const brokenUrls = await findBrokenLinks(internalNavLinks($, finalUrl));

  const contactCandidates = [...new Set([...findContactLinks($, finalUrl), `${origin}/pages/contact`, `${origin}/pages/iletisim`])].slice(0, 4);
  let hasContactPage = false;
  for (const url of contactCandidates) {
    if (await fetchOk(url)) {
      hasContactPage = true;
      break;
    }
  }

  return sortFindings([
    brokenLinksFinding(brokenUrls),
    themeFinding(parseTheme(html), /shopify-section/.test(html)),
    productHtml !== null ? reviewFinding(apps, productHtml) : null,
    altFinding(products),
    contactFinding(hasContactPage),
    viewportFinding($),
  ]);
}

async function fetchPageHtml(url: string): Promise<string | null> {
  try {
    const page = await fetchPage(url, { timeoutMs: 10_000 });
    return page.ok ? page.body : null;
  } catch {
    return null;
  }
}
