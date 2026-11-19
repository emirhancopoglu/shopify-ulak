import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { loadDotEnv } from "@/lib/env";
import * as schema from "./schema";

// Worker ve betikler de .env'i okusun (veritabanını kullanan her şey bu dosyayı import eder)
loadDotEnv();

// DB_FILE: testlerde ayrı bir veritabanı kullanmak için
export const DB_PATH = process.env.DB_FILE ?? path.join(process.cwd(), "data", "app.db");

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  // Web arayüzü ve worker aynı dosyayı aynı anda kullanıyor.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

type Db = ReturnType<typeof open>;

// Next.js dev modunda hot reload her seferinde yeni bağlantı açmasın.
const g = globalThis as unknown as { __db?: Db };
export const db: Db = g.__db ?? (g.__db = open());

export { schema };
