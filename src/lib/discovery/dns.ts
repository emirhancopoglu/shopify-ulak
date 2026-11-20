import { promises as dns } from "node:dns";

/**
 * Sayfayı açmadan DNS ile Shopify tespiti. Shopify'a bağlı alan adları:
 *  - kök alan adı A kaydı 23.227.38.x (Shopify'ın IP aralığı)
 *  - www alt alan adı CNAME → shops.myshopify.com (ya da *.myshopify.com)
 */
const SHOPIFY_IP = /^23\.227\.38\./;
const SHOPIFY_CNAME = /(^|\.)myshopify\.com\.?$/i;

async function aRecords(host: string): Promise<string[]> {
  try {
    return await dns.resolve4(host);
  } catch {
    return [];
  }
}

async function cname(host: string): Promise<string[]> {
  try {
    return await dns.resolveCname(host);
  } catch {
    return [];
  }
}

export async function looksLikeShopify(domain: string): Promise<boolean> {
  const host = domain.replace(/^www\./, "");
  const [apexA, wwwCname, apexCname] = await Promise.all([aRecords(host), cname(`www.${host}`), cname(host)]);
  return apexA.some((ip) => SHOPIFY_IP.test(ip)) || [...wwwCname, ...apexCname].some((c) => SHOPIFY_CNAME.test(c));
}
