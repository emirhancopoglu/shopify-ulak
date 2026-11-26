/**
 * Genel site keşfi pilotu (F6 Faz 3 ölçümü). Önbellekteki .tr listesinden rastgele örnek alır,
 * gerçek ağda DNS → ana sayfa platformu → (seçili platformlardan olanlarda) tam analiz yapar.
 * Veritabanına YAZMAZ; yalnızca rakam ve örnek çıktı verir. Sonuçlar data/pilot-general-*.json dosyasına da yazılır.
 *
 * Çalıştırma: npx tsx scripts/pilot-general.ts [örnekBoyutu=1000]
 */
import fs from "node:fs";
import path from "node:path";
import { hasARecord } from "../src/lib/discovery/dns";
import { probeSite, type GeneralProbe } from "../src/lib/discovery/general-probe";
import { analyzeStore, type AnalysisResult } from "../src/lib/analyzer";
import { DEFAULT_GENERAL_PLATFORMS } from "../src/lib/platform-labels";
import type { Platform } from "../src/db/schema";

const SAMPLE = Math.max(50, Number(process.argv[2]) || 1000);
const DNS_CONCURRENCY = 32;
const PROBE_CONCURRENCY = 12;
const ANALYZE_CONCURRENCY = 4;

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

function loadTrList(): string[] {
  const dir = path.join(process.cwd(), "data", "discovery");
  const file = fs.readdirSync(dir).find((f) => f.endsWith("-tr.txt"));
  if (!file) throw new Error("Önbellekte .tr listesi yok (data/discovery/*-tr.txt). Önce Genel Siteler'de alan adı arşivini çalıştırın.");
  return fs
    .readFileSync(path.join(dir, file), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.endsWith(".tr"));
}

/** Fisher–Yates ile rastgele örnek (liste sıralı olduğu için baştan almak yanlı olur). */
function sample<T>(items: T[], n: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "-");
const secs = (ms: number) => `${(ms / 1000).toFixed(0)} sn`;

async function main() {
  const all = loadTrList();
  const domains = sample([...new Set(all)], SAMPLE);
  console.log(`Liste: ${all.length.toLocaleString("tr-TR")} .tr alan adı · örnek: ${domains.length}\n`);

  // 1) DNS
  let t0 = Date.now();
  const withDns: string[] = [];
  let noDns = 0;
  await pool(domains, DNS_CONCURRENCY, async (d) => {
    try {
      if (await hasARecord(d)) withDns.push(d);
      else noDns++;
    } catch {
      noDns++;
    }
  });
  const dnsMs = Date.now() - t0;
  console.log(`1) DNS: ${withDns.length} kayıtlı, ${noDns} kayıtsız (${pct(withDns.length, domains.length)} kayıtlı) · ${secs(dnsMs)}`);

  // 2) Ana sayfa platformu
  t0 = Date.now();
  const probes = new Map<string, GeneralProbe>();
  await pool(withDns, PROBE_CONCURRENCY, async (d) => {
    try {
      probes.set(d, await probeSite(d));
    } catch {
      probes.set(d, { reachable: false, shopify: false, platform: "unknown", confidence: "low", language: null });
    }
  });
  const probeMs = Date.now() - t0;

  let unreachable = 0;
  let shopify = 0;
  const byPlatform = new Map<Platform, number>();
  const trLang = { tr: 0, other: 0 };
  for (const p of probes.values()) {
    if (!p.reachable) {
      unreachable++;
      continue;
    }
    if (p.shopify) {
      shopify++;
      continue;
    }
    byPlatform.set(p.platform, (byPlatform.get(p.platform) ?? 0) + 1);
    if (p.language === "tr") trLang.tr++;
    else trLang.other++;
  }
  const reachable = probes.size - unreachable;
  console.log(`2) Ana sayfa: ${unreachable} açılmadı · ${shopify} Shopify · ${reachable - shopify} Shopify değil · ${secs(probeMs)}`);
  console.log("   Platform dağılımı (Shopify hariç, açılan sitelerde):");
  for (const [p, n] of [...byPlatform.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${p.padEnd(10)} ${String(n).padStart(5)}  ${pct(n, reachable - shopify)}`);
  }
  console.log(`   Dil: lang="tr" ${trLang.tr}, diğer ${trLang.other}`);

  // 3) Seçili platformlar: tam analiz (iletişim e-postası, MX)
  const matched = [...probes.entries()]
    .filter(([, p]) => p.reachable && !p.shopify && DEFAULT_GENERAL_PLATFORMS.includes(p.platform))
    .map(([d, p]) => ({ domain: d, platform: p.platform, confidence: p.confidence }));
  console.log(`\n3) Varsayılan platformlardan (${DEFAULT_GENERAL_PLATFORMS.join(", ")}) eşleşen: ${matched.length} site. Tam analiz yapılıyor…`);

  t0 = Date.now();
  const results: { domain: string; platform: Platform; confidence: string; emails: number; mxValid: number; primary: string | null; error: string | null }[] = [];
  await pool(matched, ANALYZE_CONCURRENCY, async (m) => {
    let r: AnalysisResult;
    try {
      r = await analyzeStore(m.domain);
    } catch (err) {
      results.push({ ...m, emails: 0, mxValid: 0, primary: null, error: String(err) });
      return;
    }
    results.push({
      domain: m.domain,
      platform: m.platform,
      confidence: m.confidence,
      emails: r.emails.length,
      mxValid: r.emails.filter((e) => e.mxValid === true).length,
      primary: r.emails[0]?.email ?? null,
      error: r.status === "done" ? null : `${r.status}: ${r.error ?? ""}`,
    });
  });
  const analyzeMs = Date.now() - t0;

  const withEmail = results.filter((r) => r.emails > 0).length;
  const withMx = results.filter((r) => r.mxValid > 0).length;
  const failed = results.filter((r) => r.error).length;
  console.log(`   ${secs(analyzeMs)} · e-posta bulunan: ${withEmail}/${results.length} (${pct(withEmail, results.length)}) · MX geçerli: ${withMx} (${pct(withMx, results.length)}) · hata: ${failed}`);

  console.log("\nÖrnekler (ilk 25):");
  for (const r of results.slice(0, 25)) {
    console.log(`  ${r.domain.padEnd(32)} ${r.platform.padEnd(9)} ${r.confidence.padEnd(6)} ${r.primary ?? "(e-posta yok)"}${r.error ? `  [${r.error}]` : ""}`);
  }

  const out = {
    at: new Date().toISOString(),
    listSize: all.length,
    sample: domains.length,
    dns: { withDns: withDns.length, noDns },
    probe: { unreachable, shopify, notShopify: reachable - shopify, byPlatform: Object.fromEntries(byPlatform), lang: trLang },
    analysis: { matched: matched.length, withEmail, withMx, failed },
    results,
  };
  const file = path.join(process.cwd(), "data", `pilot-general-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nAyrıntılı sonuç: ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
