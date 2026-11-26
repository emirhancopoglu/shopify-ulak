import fs from "node:fs";
import path from "node:path";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Tranco: araştırma amaçlı, ücretsiz "en popüler 1 milyon site" listesi (https://tranco-list.eu).
 * Liste günlük güncellenir; her sürümün kalıcı bir kimliği var. İndirilen liste diske önbelleklenir.
 */
const BASE = "https://tranco-list.eu";
const CACHE_DIR = path.join(process.cwd(), "data", "discovery");
export const TRANCO_SIZE = 1_000_000;

/** Güncel liste kimliği (ör. JZW4Y); 1 gün önbellekli. */
export async function latestTrancoId(): Promise<string> {
  const cached = getSetting("tranco_latest");
  if (cached) {
    const { at, id } = JSON.parse(cached) as { at: number; id: string };
    if (Date.now() - at < 86_400_000 && id) return id;
  }
  const res = await fetch(`${BASE}/top-1m-id`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Tranco HTTP ${res.status}`);
  const id = (await res.text()).trim();
  if (!/^[A-Z0-9]{3,10}$/i.test(id)) throw new Error("Tranco liste kimliği okunamadı");
  setSetting("tranco_latest", JSON.stringify({ at: Date.now(), id }));
  return id;
}

const cacheFile = (id: string) => path.join(CACHE_DIR, `tranco-${id}.txt`);

/**
 * "Popüler siteler" kümesi (Tranco ilk 1 milyon): genel site keşfinde bunlar elenir, çünkü herkesin bildiği büyük siteler
 * zaten düzenli ve müşteri adayı değil. Güncel liste alınamazsa diskteki en yeni önbellek kullanılır; hiçbiri yoksa hata verir.
 */
export async function popularDomains(): Promise<string[]> {
  try {
    return await trancoDomains(await latestTrancoId());
  } catch (err) {
    const cached = fs.existsSync(CACHE_DIR)
      ? fs
          .readdirSync(CACHE_DIR)
          .filter((n) => /^tranco-[A-Z0-9]+\.txt$/i.test(n))
          .map((n) => ({ n, t: fs.statSync(path.join(CACHE_DIR, n)).mtimeMs }))
          .sort((a, b) => b.t - a.t)[0]
      : undefined;
    if (!cached) throw err;
    return fs.readFileSync(path.join(CACHE_DIR, cached.n), "utf8").split("\n").filter(Boolean);
  }
}

/** Listeyi (sıralı alan adları) döndürür; yoksa indirip önbelleğe yazar. */
export async function trancoDomains(id: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const file = cacheFile(id);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const res = await fetchFn(`${BASE}/download/${encodeURIComponent(id)}/${TRANCO_SIZE}`, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Tranco HTTP ${res.status}`);
  const domains: string[] = [];
  for (const line of (await res.text()).split("\n")) {
    const domain = line.split(",")[1]?.trim();
    if (domain) domains.push(domain);
  }
  if (domains.length === 0) throw new Error("Tranco listesi boş geldi");
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, domains.join("\n"));
  fs.renameSync(`${file}.tmp`, file);
  return domains;
}
