import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Common Crawl web graph'ın alan adı listesi (ücretsiz, ~145 milyon alan adı, ~900 MB gzip).
 * Satırlar `id \t ters.alan.adı \t host sayısı`, ters alan adına göre sıralı (tr.com.ornek).
 * Belirli uzantıları (ör. .tr) süzüp diske yazarız; sonra her birine DNS ile "Shopify mı?" diye bakılır.
 * Arama motoru kullanılmadığı için engel yok.
 */
const GRAPH_INFO = "https://index.commoncrawl.org/graphinfo.json";
const DATA_BASE = "https://data.commoncrawl.org/projects/hyperlinkgraph";
const CACHE_DIR = path.join(process.cwd(), "data", "discovery");

export const listUrl = (graph: string) => `${DATA_BASE}/${graph}/domain/${graph}-domain-vertices.txt.gz`;

/** En güncel web graph sürümü (ör. cc-main-2026-sep-oct-nov); 1 gün önbellekli. */
export async function latestGraph(): Promise<string> {
  const cached = getSetting("cc_graph_latest");
  if (cached) {
    const { at, id } = JSON.parse(cached) as { at: number; id: string };
    if (Date.now() - at < 86_400_000 && id) return id;
  }
  const res = await fetch(GRAPH_INFO, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Common Crawl graph listesi HTTP ${res.status}`);
  const [first] = (await res.json()) as { id: string }[];
  if (!first?.id) throw new Error("Common Crawl graph listesi boş");
  setSetting("cc_graph_latest", JSON.stringify({ at: Date.now(), id: first.id }));
  return first.id;
}

export const cacheFile = (graph: string, tlds: string[]) => path.join(CACHE_DIR, `${graph}-${[...tlds].sort().join("_")}.txt`);

/** Daha önce süzülmüş liste varsa okur. */
export function readCachedList(graph: string, tlds: string[]): string[] | null {
  const file = cacheFile(graph, tlds);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

/** `tr.com.ornek` → `ornek.com.tr` */
export const unreverse = (rev: string) => rev.split(".").reverse().join(".");

export type ExtractProgress = { bytes: number; totalBytes: number | null; found: number };

/**
 * Listeyi akış halinde indirir (diske tamamı yazılmaz), verilen uzantıdaki alan adlarını süzüp önbelleğe yazar.
 * Bağlantı koparsa Range ile kaldığı bayttan devam eder. Liste sıralı olduğu için son uzantıyı geçince durur.
 */
export async function extractTldDomains(
  graph: string,
  tlds: string[],
  opts: { onProgress?: (p: ExtractProgress) => void; shouldStop?: () => boolean; fetchFn?: typeof fetch } = {},
): Promise<string[] | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const wanted = new Set(tlds.map((t) => t.toLowerCase().replace(/^\./, "")));
  const lastTld = [...wanted].sort().at(-1)!;
  const url = listUrl(graph);

  const gunzip = zlib.createGunzip();
  const found: string[] = [];
  let rest = "";
  let passed = false; // son uzantıyı geçtik mi (sıralı liste)
  gunzip.on("data", (chunk: Buffer) => {
    if (passed) return;
    const lines = (rest + chunk.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      const rev = line.split("\t")[1];
      if (!rev) continue;
      const dot = rev.indexOf(".");
      const tld = dot === -1 ? rev : rev.slice(0, dot);
      if (wanted.has(tld)) {
        if (dot !== -1) found.push(unreverse(rev));
      }
      else if (tld > lastTld) {
        passed = true;
        break;
      }
    }
  });
  const gzError = new Promise<never>((_, reject) => gunzip.on("error", reject));
  gzError.catch(() => {});

  let bytes = 0;
  let totalBytes: number | null = null;
  let failures = 0;
  let lastReport = 0;

  while (!passed) {
    if (opts.shouldStop?.()) return null;
    let res: Response;
    try {
      res = await fetchFn(url, { headers: bytes ? { Range: `bytes=${bytes}-` } : {}, signal: AbortSignal.timeout(120_000) });
      if (!(res.ok || res.status === 206) || !res.body) throw new Error(`Common Crawl HTTP ${res.status}`);
      if (bytes && res.status !== 206) throw new Error("Sunucu kaldığı yerden devam etmeyi desteklemedi");
      if (totalBytes === null) totalBytes = Number(res.headers.get("content-length")) || null;
    } catch (err) {
      if (++failures > 5) throw err;
      await new Promise((r) => setTimeout(r, 5_000 * failures));
      continue;
    }

    try {
      const reader = res.body.getReader();
      while (!passed) {
        if (opts.shouldStop?.()) {
          await reader.cancel();
          return null;
        }
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        failures = 0;
        if (!gunzip.write(value)) await Promise.race([new Promise((r) => gunzip.once("drain", r)), gzError]);
        if (opts.onProgress && bytes - lastReport > 8 * 1024 * 1024) {
          lastReport = bytes;
          opts.onProgress({ bytes, totalBytes, found: found.length });
        }
      }
      if (passed) await reader.cancel().catch(() => {});
      else if (totalBytes === null || bytes >= totalBytes) break; // dosya bitti
    } catch (err) {
      if (passed) break;
      if (++failures > 5) throw err;
      await new Promise((r) => setTimeout(r, 5_000 * failures));
    }
  }
  if (passed) gunzip.destroy();
  else {
    gunzip.end();
    await Promise.race([new Promise((r) => gunzip.once("end", r)), gzError]);
  }

  const unique = [...new Set(found)];
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = cacheFile(graph, [...wanted]);
  fs.writeFileSync(`${file}.tmp`, unique.join("\n"));
  fs.renameSync(`${file}.tmp`, file);
  return unique;
}
