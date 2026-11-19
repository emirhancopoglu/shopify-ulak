import { db, schema } from "@/db";

export type JobType = "analyze_store";
export type JobPayloads = { analyze_store: { storeId: number } };

export type ClaimedJob = { id: number; type: string; payload: unknown; attempts: number };

export function enqueue<T extends JobType>(type: T, payloads: JobPayloads[T][]) {
  if (payloads.length === 0) return;
  db.insert(schema.jobs)
    .values(payloads.map((payload) => ({ type, payload })))
    .run();
}

/** Sıradaki işleri atomik olarak "running" yapar ve döndürür. */
export function claimJobs(limit: number): ClaimedJob[] {
  if (limit <= 0) return [];
  const now = Date.now();
  const rows = db.$client
    .prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
       WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY id LIMIT ?)
       RETURNING id, type, payload, attempts`,
    )
    .all(now, now, limit) as { id: number; type: string; payload: string; attempts: number }[];
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export const MAX_ATTEMPTS = 3;

export function finishJob(id: number) {
  db.$client.prepare(`UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function failJob(id: number, attempts: number, error: string) {
  const now = Date.now();
  if (attempts >= MAX_ATTEMPTS) {
    db.$client.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(error, now, id);
  } else {
    db.$client
      .prepare(`UPDATE jobs SET status = 'queued', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?`)
      .run(error, now + 30_000 * attempts, now, id);
  }
}

/** Worker çökerse/kapanırsa yarım kalan işleri sıraya geri koyar. */
export function requeueRunning() {
  return db.$client.prepare(`UPDATE jobs SET status = 'queued', attempts = MAX(attempts - 1, 0) WHERE status = 'running'`).run().changes;
}

/** Bitmiş işleri temizler (tablo şişmesin). */
export function pruneJobs(olderThanMs = 24 * 3600_000) {
  db.$client.prepare(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`).run(Date.now() - olderThanMs);
}

export const HEARTBEAT_KEY = "worker_heartbeat";

export function writeHeartbeat() {
  const now = Date.now();
  db.$client
    .prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(HEARTBEAT_KEY, String(now), now);
}

export function readHeartbeat(): number | null {
  const row = db.$client.prepare(`SELECT value FROM kv WHERE key = ?`).get(HEARTBEAT_KEY) as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

/** Worker son 5 saniyede sinyal verdiyse çalışıyor sayılır. */
export function isWorkerAlive(): boolean {
  const hb = readHeartbeat();
  return hb !== null && Date.now() - hb < 5000;
}
