import { fetchJson } from "@/lib/analyzer/http";
import type { ShopifyMeta } from "@/lib/analyzer/storefront";
import { normalizeDomain } from "@/lib/domains";

export type Probe = {
  shopify: boolean;
  /** Mağazanın asıl alan adı (meta.json "domain"), yoksa sorgulanan adres */
  domain: string;
  myshopify: string | null;
  country: string | null;
  currency: string | null;
};

/**
 * Hızlı ön kontrol: tek bir /meta.json isteği. Tam analizden (ana sayfa + ürünler + iletişim
 * sayfaları) çok daha ucuz; keşifte binlerce adayı süzmek için kullanılır.
 */
export async function probeStore(host: string): Promise<Probe> {
  const meta = await fetchJson<ShopifyMeta>(`https://${host}/meta.json`);
  if (!meta || !(meta.myshopify_domain || typeof meta.published_products_count === "number")) {
    return { shopify: false, domain: host, myshopify: null, country: null, currency: null };
  }
  return {
    shopify: true,
    domain: normalizeDomain(meta.domain ?? "") ?? host,
    myshopify: meta.myshopify_domain?.toLowerCase() ?? null,
    country: meta.country ?? null,
    currency: meta.currency ?? null,
  };
}

export const isTurkish = (p: Pick<Probe, "country" | "currency">) =>
  p.country?.toUpperCase() === "TR" || p.currency?.toUpperCase() === "TRY";
