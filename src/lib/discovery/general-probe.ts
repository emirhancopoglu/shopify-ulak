import { fetchPage, type Page } from "@/lib/analyzer/http";
import { detectPlatform } from "@/lib/analyzer/platform";
import { hasShopifyHeaders, hasShopifyMarkup } from "@/lib/analyzer/storefront";
import type { Platform, PlatformConfidence } from "@/db/schema";
import { homepageHints, segmentFromHomepage, type SiteSegment } from "./segments";

/**
 * Genel site keşfi için hızlı kontrol (F6 Faz 3): ana sayfa tek istek, platform tespiti.
 * Tam analiz (iletişim sayfaları, e-posta) yalnızca eklenen siteler için analiz kuyruğunda yapılır.
 */
export type GeneralProbe = {
  reachable: boolean;
  /** Shopify izi var (genel kaynaklarda bunlar Shopify sekmesine aittir, atlanır) */
  shopify: boolean;
  platform: Platform;
  confidence: PlatformConfidence;
  language: string | null;
  /** Ana sayfa içeriğine göre hedef dışı tür (haber, avukat, kamu); yoksa null */
  segment?: SiteSegment | null;
};

const PROBE_TIMEOUT_MS = 8_000;

const UNREACHABLE: GeneralProbe = { reachable: false, shopify: false, platform: "unknown", confidence: "low", language: null, segment: null };

async function openHomeQuick(host: string) {
  try {
    return await fetchPage(`https://${host}/`, { timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    return fetchPage(`http://${host}/`, { timeoutMs: PROBE_TIMEOUT_MS });
  }
}

export async function probeSite(host: string): Promise<GeneralProbe> {
  let page: Page;
  try {
    page = await openHomeQuick(host);
  } catch {
    return UNREACHABLE;
  }
  if (page.status >= 400 && page.status !== 401 && page.status !== 403) return UNREACHABLE;

  const html = page.body;
  const shopify = hasShopifyHeaders(page.headers) || hasShopifyMarkup(html);
  const detected = detectPlatform({ html, headers: page.headers });
  const language = html.match(/<html[^>]*\slang=["']([a-z]{2})/i)?.[1]?.toLowerCase() ?? null;
  const segment = segmentFromHomepage(homepageHints(html));

  return { reachable: true, shopify, platform: detected.platform, confidence: detected.confidence, language, segment };
}
