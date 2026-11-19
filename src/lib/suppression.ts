import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";

const { suppression } = schema;

export type SuppressionReason = "unsubscribe" | "bounce" | "manual";

export { SUPPRESSION_LABEL } from "./suppression-labels";

export function isSuppressed(email: string): boolean {
  return Boolean(db.select({ e: suppression.email }).from(suppression).where(eq(suppression.email, email.toLowerCase())).get());
}

export function suppress(email: string, reason: SuppressionReason, note?: string) {
  db.insert(suppression)
    .values({ email: email.toLowerCase(), reason, note: note ?? null })
    .onConflictDoNothing()
    .run();
}

export function unsuppress(email: string) {
  db.delete(suppression).where(eq(suppression.email, email.toLowerCase())).run();
}

export function listSuppression() {
  return db.select().from(suppression).orderBy(desc(suppression.createdAt)).all();
}
