/**
 * Gönderilecek HTML maildeki uzak görselleri (<img src="https://...">) indirip
 * MIME inline eki (cid:) olarak gömer.
 *
 * Neden: Outlook ve birçok mail istemcisi dış URL'li görselleri "İçeriği göster"e
 * tıklamadan indirmez. Görsel CID eki olarak mailin içine gömüldüğünde Gelen Kutusu'nda
 * ek tıklama gerektirmeden görünür.
 */

export type InlineAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
  cid: string;
  contentDisposition: "inline";
};

export type FetchedImage = {
  content: Buffer;
  contentType: string;
  filename?: string;
};

export type FetchImageFn = (url: string) => Promise<FetchedImage | null>;

const MAX_IMAGES = 5;
const MAX_BYTES = 512 * 1024; // 512 KB (imza/logo görseli için fazlasıyla yeterli)
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 dk: kampanya gönderimlerinde aynı logoyu tekrar indirme

const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

type CacheEntry = { image: FetchedImage | null; expiresAt: number };
const imageCache = new Map<string, CacheEntry>();

/** Testler için önbelleği temizler. */
export function clearInlineImageCache() {
  imageCache.clear();
}

function decodeHtmlAttr(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function filenameFromUrl(url: string, ext: string, index: number): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").pop()?.replace(/[^a-zA-Z0-9._-]/g, "") ?? "";
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  } catch {
    // geçersiz URL ise varsayılan ada düş
  }
  return `image-${index + 1}.${ext}`;
}

export async function defaultFetchImage(url: string): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "image/png,image/jpeg,image/gif,image/webp,*/*;q=0.5" },
    });
    if (!res.ok) {
      console.warn(`[mail-img] Görsel indirilemedi (${res.status}): ${url}`);
      return null;
    }
    const rawType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = ALLOWED_TYPES[rawType];
    if (!ext) {
      console.warn(`[mail-img] Desteklenmeyen görsel türü (${rawType || "yok"}), CID atlandı: ${url}`);
      return null;
    }
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BYTES) {
      console.warn(`[mail-img] Görsel çok büyük (${contentLength} bayt > ${MAX_BYTES}), CID atlandı: ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      console.warn(`[mail-img] Görsel boyutu uygun değil (${buf.length} bayt), CID atlandı: ${url}`);
      return null;
    }
    return { content: buf, contentType: rawType === "image/jpg" ? "image/jpeg" : rawType };
  } catch (err) {
    console.warn(`[mail-img] Görsel indirme hatası (${url}): ${(err as Error).message}`);
    return null;
  }
}

async function fetchCached(url: string, fetchFn: FetchImageFn, useCache: boolean): Promise<FetchedImage | null> {
  if (!useCache) return fetchFn(url);
  const now = Date.now();
  const hit = imageCache.get(url);
  if (hit && hit.expiresAt > now) return hit.image;
  const image = await fetchFn(url);
  // Başarılıysa 10 dk, başarısızsa 1 dk önbelleğe al (bozuk URL her mailde bekleme yapmasın)
  imageCache.set(url, { image, expiresAt: now + (image ? CACHE_TTL_MS : 60_000) });
  return image;
}

const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;

/**
 * HTML içindeki uzak <img src="https://..."> görsellerini indirip cid: ekiyle değiştirir.
 * İndirilemeyen görseller orijinal URL'iyle kalır; gönderimi bozmaz.
 */
export async function inlineRemoteImages(
  html: string,
  opts: { fetchImage?: FetchImageFn; useCache?: boolean } = {},
): Promise<{ html: string; attachments: InlineAttachment[] }> {
  const fetchFn = opts.fetchImage ?? defaultFetchImage;
  const useCache = opts.useCache ?? !opts.fetchImage;

  const matches = [...html.matchAll(IMG_SRC_RE)];
  if (matches.length === 0) return { html, attachments: [] };

  // Benzersiz URL'leri sırayla topla (en fazla MAX_IMAGES)
  const uniqueUrls: string[] = [];
  const rawToDecoded = new Map<string, string>();
  for (const m of matches) {
    const rawUrl = m[3];
    const decoded = decodeHtmlAttr(rawUrl);
    rawToDecoded.set(rawUrl, decoded);
    if (!uniqueUrls.includes(decoded) && uniqueUrls.length < MAX_IMAGES) {
      uniqueUrls.push(decoded);
    }
  }

  const urlToCid = new Map<string, string>();
  const attachments: InlineAttachment[] = [];

  for (let i = 0; i < uniqueUrls.length; i++) {
    const url = uniqueUrls[i];
    const img = await fetchCached(url, fetchFn, useCache);
    if (!img) continue;
    const ext = ALLOWED_TYPES[img.contentType.toLowerCase()] ?? "png";
    const cid = `inline-img-${i + 1}@ulak.local`;
    urlToCid.set(url, cid);
    attachments.push({
      filename: img.filename ?? filenameFromUrl(url, ext, i),
      content: img.content,
      contentType: img.contentType,
      cid,
      contentDisposition: "inline",
    });
  }

  if (attachments.length === 0) return { html, attachments: [] };

  const rewritten = html.replace(IMG_SRC_RE, (full, prefix: string, quote: string, rawUrl: string) => {
    const decoded = rawToDecoded.get(rawUrl) ?? decodeHtmlAttr(rawUrl);
    const cid = urlToCid.get(decoded);
    return cid ? `${prefix}${quote}cid:${cid}${quote}` : full;
  });

  return { html: rewritten, attachments };
}
