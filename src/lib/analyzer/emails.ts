import type { CheerioAPI } from "cheerio";
import { promises as dns } from "node:dns";
import { sameSite } from "../domains";

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}/gi;

const FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|css|js|json|woff2?|ttf|mp4)$/i;

const BLOCKED_DOMAINS = [
  "example.com",
  "example.org",
  "domain.com",
  "email.com",
  "yourdomain.com",
  "yourstore.com",
  "mail.com",
  "sentry.io",
  "sentry-next.wixpress.com",
  "wixpress.com",
  "shopify.com",
  "myshopify.com",
  "shopifyemail.com",
  "klaviyo.com",
  "judge.me",
  "u.ac",
];

const BLOCKED_LOCALPARTS = /^(name|your|yourname|email|adiniz|isim|test|noreply|no-reply|donotreply|user|username)$/i;

/** Satış maili için tercih edilen genel adresler (Türkçe + İngilizce). */
const PREFERRED_LOCALPARTS =
  /^(info|bilgi|iletisim|contact|hello|merhaba|selam|destek|support|sales|satis|musterihizmetleri|customerservice|customer|cs|shop|store|magaza|siparis|order|orders|team|hi)$/i;

const AVOID_LOCALPARTS = /^(kvkk|privacy|gizlilik|legal|hukuk|abuse|dmca|iade|returns|refund|career|kariyer|ik|hr|jobs|muhasebe|fatura|accounting)$/i;

export function cleanEmail(raw: string): string | null {
  let e = raw.trim().toLowerCase();
  try {
    e = decodeURIComponent(e);
  } catch {
    /* olduğu gibi kalsın */
  }
  e = e.replace(/^mailto:/, "").split("?")[0].replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  // JSON kaçış artıkları: "u003einfo@..." gibi
  e = e.replace(/^u00[0-9a-f]{2}/, "");
  const m = e.match(new RegExp(`^${EMAIL_RE.source}$`, "i"));
  if (!m) return null;
  const [local, domain] = e.split("@");
  if (FILE_EXT_RE.test(e)) return null;
  if (BLOCKED_LOCALPARTS.test(local)) return null;
  if (BLOCKED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;
  return e;
}

/** Bir sayfadaki mail adreslerini toplar (mailto linkleri + görünen metin + JSON-LD). */
export function extractEmails($: CheerioAPI): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const e = cleanEmail(raw);
    if (e) found.add(e);
  };

  $('a[href^="mailto:" i]').each((_, el) => add($(el).attr("href") ?? ""));

  $('script[type="application/ld+json"]').each((_, el) => {
    for (const m of $(el).text().matchAll(EMAIL_RE)) add(m[0]);
  });

  const $clone = $.root().clone();
  $clone.find("script, style, noscript, svg, template").remove();
  // .text() bitişik elemanları boşluksuz birleştirir ("info@x.com" + "Telefon" → "info@x.comtelefon"),
  // bu yüzden metin düğümlerini tek tek boşlukla birleştiriyoruz.
  const parts: string[] = [];
  $clone
    .find("*")
    .contents()
    .each((_, node) => {
      if (node.type === "text") parts.push(node.data);
    });
  const text = parts.join(" ").replace(/\s*\[\s*(at|@)\s*\]\s*|\s+\(at\)\s+/gi, "@");
  for (const m of text.matchAll(EMAIL_RE)) add(m[0]);

  return [...found];
}

/** Puan yüksek olan "birincil" adres seçilir. */
export function rankEmail(email: string, storeHost: string): number {
  const [local, domain] = email.split("@");
  let score = 0;
  if (sameSite(domain, storeHost)) score += 10;
  if (PREFERRED_LOCALPARTS.test(local)) score += 5;
  if (AVOID_LOCALPARTS.test(local)) score -= 4;
  if (/^(gmail|hotmail|outlook|yahoo|yandex|icloud)\./.test(domain)) score += 1;
  return score;
}

const mxCache = new Map<string, Promise<boolean | null>>();

/** true: MX kaydı var, false: alan adı mail almıyor, null: kontrol edilemedi. */
export function hasMx(domain: string): Promise<boolean | null> {
  let p = mxCache.get(domain);
  if (!p) {
    p = dns
      .resolveMx(domain)
      .then((r) => r.length > 0)
      .catch((err: NodeJS.ErrnoException) =>
        err.code === "ENOTFOUND" || err.code === "ENODATA" ? false : null,
      );
    mxCache.set(domain, p);
  }
  return p;
}
