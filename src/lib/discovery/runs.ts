import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { DiscoveryRun, DiscoverySource, DiscoveryStats, DiscoveryStatus } from "@/db/schema";
import { enqueue } from "@/lib/jobs";

const { discoveryRuns: runs } = schema;

export const emptyStats = (total = 0): DiscoveryStats => ({ total, cursor: 0, candidates: 0, known: 0, shopify: 0, matched: 0, added: 0 });

export function createRun(source: DiscoverySource, params: Record<string, unknown>, total: number) {
  const row = db
    .insert(runs)
    .values({ source, params, stats: emptyStats(total), log: [] })
    .returning({ id: runs.id })
    .get();
  enqueue("discover", [{ runId: row.id }]);
  return row.id;
}

export function getRun(id: number): DiscoveryRun | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

export function listRuns(limit = 30): DiscoveryRun[] {
  return db.select().from(runs).orderBy(desc(runs.id)).limit(limit).all();
}

const ACTIVE = inArray(runs.status, ["queued", "running"]);

/** Kaynak başına tek aktif çalıştırma (aynı kaynağa paralel istek atıp engel yememek için); kaynaklar birbirini beklemez. */
export function hasActiveRun(source?: DiscoverySource): boolean {
  const where = source ? and(ACTIVE, eq(runs.source, source)) : ACTIVE;
  return Boolean(db.select({ id: runs.id }).from(runs).where(where).get());
}

export function setRunStatus(id: number, status: DiscoveryStatus, error: string | null = null) {
  const now = new Date();
  db.update(runs)
    .set({
      status,
      error,
      ...(status === "running" ? { startedAt: now, finishedAt: null } : {}),
      ...(["done", "failed", "cancelled", "blocked"].includes(status) ? { finishedAt: now } : {}),
    })
    .where(eq(runs.id, id))
    .run();
}

export function saveStats(id: number, stats: DiscoveryStats) {
  db.update(runs).set({ stats }).where(eq(runs.id, id)).run();
}

const MAX_LOG = 80;

export function appendLog(id: number, message: string) {
  const run = getRun(id);
  if (!run) return;
  const time = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  db.update(runs)
    .set({ log: [...run.log, `${time}  ${message}`].slice(-MAX_LOG) })
    .where(eq(runs.id, id))
    .run();
}

export function isCancelled(id: number): boolean {
  return getRun(id)?.status === "cancelled";
}

export function cancelRun(id: number) {
  db.update(runs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(runs.id, id))
    .run();
}

/** Engellenen/iptal edilen/başarısız çalıştırmayı kaldığı yerden sürdürür. */
export function resumeRun(id: number) {
  const run = getRun(id);
  if (!run || !["blocked", "failed", "cancelled"].includes(run.status)) return false;
  // total 0: liste henüz indirilmeden yarıda kalmış (alan adı arşivi), yine sürdürülebilir
  if (run.stats.total > 0 && run.stats.cursor >= run.stats.total) return false;
  // Elle devam: otomatik bekleme ve engel sayacı sıfırdan başlar
  const stats = { ...run.stats, waitUntil: null, waitReason: null, blockStreak: 0 };
  db.update(runs).set({ status: "queued", error: null, finishedAt: null, stats }).where(eq(runs.id, id)).run();
  enqueue("discover", [{ runId: id }]);
  return true;
}

export function deleteRun(id: number) {
  db.delete(runs).where(eq(runs.id, id)).run();
}
