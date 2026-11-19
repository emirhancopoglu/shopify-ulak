import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, DB_PATH } from "../src/db";

migrate(db, { migrationsFolder: "./drizzle" });
console.log(`[db] migrations applied → ${DB_PATH}`);
