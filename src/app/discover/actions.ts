"use server";

import { refresh } from "next/cache";
import type { FormState } from "@/components/ui";
import type { Platform } from "@/db/schema";
import { describeError } from "@/lib/analyzer/http";
import { isGeneralPlatform } from "@/lib/platform-labels";
import { buildQueries, VARIATIONS } from "@/lib/discovery/ddg";
import { latestGraph } from "@/lib/discovery/domainlist";
import { latestTrancoId, TRANCO_SIZE } from "@/lib/discovery/tranco";
import { cancelRun, createRun, deleteRun, getRun, hasActiveRun, resumeRun } from "@/lib/discovery/runs";
import { extractDomains } from "@/lib/domains";

const ACTIVE_MSG = "Bu kaynakta zaten çalışan bir keşif var. Bitmesini bekleyin ya da iptal edin (diğer kaynakları aynı anda çalıştırabilirsiniz).";

export async function startSearchAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (hasActiveRun("search")) return { ok: false, message: ACTIVE_MSG };
  const keywords = String(fd.get("keywords") ?? "")
    .split(/\r?\n|,/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 300);
  const allowed = new Set(VARIATIONS.map((v) => v.value));
  const variations = fd.getAll("variations").map(String).filter((v) => allowed.has(v));
  if (keywords.length === 0) return { ok: false, message: "En az bir kelime girin." };
  if (variations.length === 0) return { ok: false, message: "En az bir varyasyon seçin." };
  const queries = buildQueries(keywords, variations);
  createRun("search", { queries, keywords, variations, trOnly: fd.get("trOnly") === "on" }, queries.length);
  refresh();
  return { ok: true, message: `${queries.length} sorguluk arama başlatıldı.` };
}

export async function startCommonCrawlAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (hasActiveRun("commoncrawl")) return { ok: false, message: ACTIVE_MSG };
  const index = String(fd.get("index") ?? "").trim();
  const startPage = Math.max(0, Math.floor(Number(fd.get("startPage")) || 0));
  const pageCount = Math.min(200, Math.max(1, Math.floor(Number(fd.get("pageCount")) || 1)));
  if (!/^CC-MAIN-\d{4}-\d{2}$/.test(index)) return { ok: false, message: "Geçerli bir dizin seçin (ör. CC-MAIN-2026-43)." };
  createRun("commoncrawl", { index, startPage, pageCount, trOnly: fd.get("trOnly") === "on" }, pageCount);
  refresh();
  return { ok: true, message: `${index}: ${startPage}. sayfadan itibaren ${pageCount} sayfa taranacak.` };
}

export async function startDnsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (hasActiveRun("dns")) return { ok: false, message: ACTIVE_MSG };
  const { domains } = extractDomains(String(fd.get("domains") ?? ""));
  const clean = domains.filter((d) => !d.endsWith(".myshopify.com")).slice(0, 20_000);
  const myshopify = domains.filter((d) => d.endsWith(".myshopify.com"));
  if (clean.length === 0 && myshopify.length === 0) return { ok: false, message: "Listede geçerli alan adı bulunamadı." };
  // myshopify adresleri zaten Shopify; DNS kontrolüne gerek yok ama aynı akıştan geçsin
  createRun("dns", { domains: [...myshopify, ...clean], trOnly: fd.get("trOnly") === "on" }, myshopify.length + clean.length);
  refresh();
  return { ok: true, message: `${myshopify.length + clean.length} alan adı kontrol edilecek.` };
}

export async function startCcDomainsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (hasActiveRun("ccdomains")) return { ok: false, message: ACTIVE_MSG };
  let graph: string;
  try {
    graph = await latestGraph();
  } catch (err) {
    return { ok: false, message: `Common Crawl'a ulaşılamadı (${describeError(err)}). Biraz sonra tekrar deneyin.` };
  }
  createRun("ccdomains", { graph, tlds: ["tr"], trOnly: fd.get("trOnly") === "on" }, 0);
  refresh();
  return { ok: true, message: `${graph}: .tr alan adları taranacak.` };
}

export async function startTrancoAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (hasActiveRun("tranco")) return { ok: false, message: ACTIVE_MSG };
  const start = Math.min(TRANCO_SIZE - 1, Math.max(0, Math.floor(Number(fd.get("start")) || 0)));
  const limit = Math.min(TRANCO_SIZE - start, Math.max(1000, Math.floor(Number(fd.get("limit")) || 100_000)));
  let listId: string;
  try {
    listId = await latestTrancoId();
  } catch (err) {
    return { ok: false, message: `Tranco'ya ulaşılamadı (${describeError(err)}). Biraz sonra tekrar deneyin.` };
  }
  createRun("tranco", { listId, start, limit, trOnly: fd.get("trOnly") === "on" }, limit);
  refresh();
  return { ok: true, message: `Tranco ${listId}: ${start + 1}. siteden itibaren ${limit.toLocaleString("tr-TR")} site taranacak.` };
}

export async function startWaybackAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (hasActiveRun("wayback")) return { ok: false, message: ACTIVE_MSG };
  const startPage = Math.max(0, Math.floor(Number(fd.get("startPage")) || 0));
  const pageCount = Math.min(500, Math.max(1, Math.floor(Number(fd.get("pageCount")) || 1)));
  createRun("wayback", { startPage, pageCount, trOnly: fd.get("trOnly") === "on" }, pageCount);
  refresh();
  return { ok: true, message: `Wayback: ${startPage}. sayfadan itibaren ${pageCount} sayfa taranacak.` };
}

// ---------------------------------------------------------------------------
// Genel siteler (F6 Faz 3)
// ---------------------------------------------------------------------------

/** Formdan gelen platform seçimleri (yalnızca izinli değerler). */
function parsePlatforms(fd: FormData): Platform[] {
  return fd.getAll("platforms").map(String).filter(isGeneralPlatform);
}

export async function startGeneralCcDomainsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  if (hasActiveRun("general_ccdomains")) return { ok: false, message: ACTIVE_MSG };
  const platforms = parsePlatforms(fd);
  if (platforms.length === 0) return { ok: false, message: "En az bir platform seçin." };
  let graph: string;
  try {
    graph = await latestGraph();
  } catch (err) {
    return { ok: false, message: `Common Crawl'a ulaşılamadı (${describeError(err)}). Biraz sonra tekrar deneyin.` };
  }
  const start = Math.max(0, Math.floor(Number(fd.get("start")) || 0));
  const limit = Math.min(500_000, Math.max(1000, Math.floor(Number(fd.get("limit")) || 20_000)));
  createRun("general_ccdomains", { graph, tlds: ["tr"], start, limit, platforms, trOnly: true }, limit);
  refresh();
  return { ok: true, message: `${graph}: ${start + 1}. alan adından itibaren ${limit.toLocaleString("tr-TR")} .tr alan adı genel site olarak taranacak.` };
}

const isId = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

export async function cancelRunAction(id: number) {
  if (!isId(id)) return;
  cancelRun(id);
  refresh();
}

export async function resumeRunAction(id: number): Promise<FormState> {
  if (!isId(id)) return null;
  const run = getRun(id);
  if (!run) return null;
  if (hasActiveRun(run.source)) return { ok: false, message: ACTIVE_MSG };
  const ok = resumeRun(id);
  refresh();
  return ok ? { ok: true, message: "Kaldığı yerden devam ediyor." } : { ok: false, message: "Bu çalıştırma devam ettirilemez." };
}

export async function deleteRunAction(id: number) {
  if (!isId(id)) return;
  deleteRun(id);
  refresh();
}
