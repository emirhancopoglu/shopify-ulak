const HOST_RE =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59})$/;

/**
 * "https://www.Ornek.com.tr/collections/x?y=1" → "ornek.com.tr"
 * Türkçe karakterli alan adlarını punycode'a çevirir. Geçersizse null döner.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().replace(/^["'<(]+|["'>),;.]+$/g, "");
  if (!s || s.includes("@")) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return HOST_RE.test(host) ? host : null;
}

/** Serbest metinden (CSV, liste, yapıştırılan içerik) benzersiz alan adlarını çıkarır. */
export function extractDomains(text: string): { domains: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;|\t]+/)) {
    if (!token.trim()) continue;
    const d = normalizeDomain(token);
    if (d) seen.add(d);
    else if (/[a-z0-9]\.[a-z]/i.test(token) && !token.includes("@")) invalid.push(token);
  }
  return { domains: [...seen], invalid };
}

/** "shop.ornek.com.tr" ile "ornek.com.tr" aynı markaya mı ait? (kaba kontrol) */
export function sameSite(a: string, b: string): boolean {
  const root = (h: string) => {
    const parts = h.toLowerCase().replace(/^www\./, "").split(".");
    // ornek.com.tr, ornek.co.uk gibi iki seviyeli uzantılar
    const twoLevel = parts.length >= 3 && /^(com|co|net|org|gen|biz|web|av)$/.test(parts[parts.length - 2]);
    return parts.slice(twoLevel ? -3 : -2).join(".");
  };
  return root(a) === root(b);
}
