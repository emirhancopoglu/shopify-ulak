const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_BYTES = 4 * 1024 * 1024;

export type Page = {
  ok: boolean;
  status: number;
  url: string; // yönlendirmelerden sonraki son adres
  headers: Headers;
  body: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchPage(
  url: string,
  opts: { timeoutMs?: number; accept?: string } = {},
): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      headers: {
        "user-agent": USER_AGENT,
        accept: opts.accept ?? "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
    });
    // Shopify hız sınırı: bir kez bekleyip tekrar dene.
    if (res.status === 429 && attempt === 0) {
      await res.body?.cancel();
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 3000);
      continue;
    }
    return { ok: res.ok, status: res.status, url: res.url || url, headers: res.headers, body: await readLimited(res) };
  }
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** JSON döndürmeyen ya da hata veren adreslerde null döner (hata fırlatmaz). */
export async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const page = await fetchPage(url, { accept: "application/json" });
    if (!page.ok) return null;
    const ct = page.headers.get("content-type") ?? "";
    if (!ct.includes("json") && !page.body.trimStart().startsWith("{")) return null;
    return JSON.parse(page.body) as T;
  } catch {
    return null;
  }
}

/** Ağ hatalarını okunabilir Türkçe mesaja çevirir. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (err.name === "TimeoutError" ? "TIMEOUT" : undefined);
    switch (code) {
      case "ENOTFOUND":
        return "Alan adı bulunamadı (DNS)";
      case "ECONNREFUSED":
        return "Bağlantı reddedildi";
      case "ECONNRESET":
        return "Bağlantı koptu";
      case "TIMEOUT":
      case "UND_ERR_CONNECT_TIMEOUT":
        return "Zaman aşımı";
      case "CERT_HAS_EXPIRED":
      case "ERR_TLS_CERT_ALTNAME_INVALID":
      case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
        return "SSL sertifika hatası";
    }
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}
