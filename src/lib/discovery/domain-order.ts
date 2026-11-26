// Saf yardımcılar (DB yok): genel site taramasında alan adı listesinin sırası ve elenecek uzantılar.

/**
 * Hedef dışı uzantılar: kamu/kurum (belediye, devlet, üniversite, okul, askeri, polis, KEP) ve avukatlar (.av.tr).
 * Bunlar müşteri adayı değil; `.av.tr` tek başına alfabetik listenin ilk dilimini dolduruyordu (2.452 alan adı).
 */
const EXCLUDED_SUFFIXES = [".gov.tr", ".edu.tr", ".bel.tr", ".k12.tr", ".mil.tr", ".pol.tr", ".kep.tr", ".tsk.tr", ".av.tr"] as const;

export function isExcludedSuffix(host: string): boolean {
  const h = host.toLowerCase();
  return EXCLUDED_SUFFIXES.some((s) => h.endsWith(s));
}

/** Küçük, tekrarlanabilir rastgele sayı üreteci (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Metinden 32 bit tohum (FNV-1a). */
function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Listeyi tohuma bağlı, tekrarlanabilir biçimde karıştırır (Fisher–Yates). Girdi değişmez.
 * Aynı liste ve aynı tohum her zaman aynı sırayı verir; böylece "başlangıç sırası / adet" dilimleri art arda
 * çalıştırıldığında çakışmaz ve yarıda kalan tarama aynı yerden sürer.
 *
 * Neden: Common Crawl listesi ters alan adına göre alfabetik sıralı. İlk dilimler yalnızca "0…b" harfleriyle
 * başlayan adları ve uzantı bloklarını (.av.tr, .bel.tr) içeriyordu; avukat ve belediye siteleri taramayı doldurdu.
 */
export function seededShuffle<T>(list: readonly T[], seedText: string): T[] {
  const out = list.slice();
  const rand = mulberry32(seedFrom(seedText));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
