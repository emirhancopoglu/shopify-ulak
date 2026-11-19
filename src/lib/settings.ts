import { db } from "@/db";

/** kv tablosu üzerinde basit uygulama ayarları. */
export function getSetting(key: string): string | null {
  const row = db.$client.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null) {
  if (value === null || value === "") {
    db.$client.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
    return;
  }
  const now = Date.now();
  db.$client
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now);
}
