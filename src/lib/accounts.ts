import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Account } from "@/db/schema";
import { verifyGmail } from "@/lib/mailer";
import { encodeOutlookSecret, forgetOutlookToken } from "@/lib/outlook";
import { encrypt } from "@/lib/secret";

const { accounts } = schema;

/** Arayüze gönderilen güvenli görünüm (şifre içermez). */
export type AccountView = Omit<Account, "secret"> & { sent24h: number };

export const DAY_MS = 24 * 3600_000;

/** Hesaptan kayan son 24 saatte gönderilen mail sayısı (tüm kampanyalar). */
export function sentInLast24h(accountId: number, now = Date.now()): number {
  const row = db.$client
    .prepare(
      `SELECT COUNT(*) AS n FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.account_id = ? AND r.status = 'sent' AND r.sent_at > ?`,
    )
    .get(accountId, now - DAY_MS) as { n: number };
  return row.n;
}

// Liste sorgusu şifre sütununu hiç okumaz
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { secret: _secret, ...publicColumns } = getTableColumns(accounts);

export function listAccounts(): AccountView[] {
  return db
    .select(publicColumns)
    .from(accounts)
    .orderBy(desc(accounts.id))
    .all()
    .map((a) => ({ ...a, sent24h: sentInLast24h(a.id) }));
}

export function getAccount(id: number): Account | undefined {
  return db.select().from(accounts).where(eq(accounts.id, id)).get();
}

export type AccountInput = {
  email: string;
  fromName: string;
  password: string;
  dailyLimit: number;
  signature: string;
};

/** Gmail'e bağlanıp şifreyi doğrular, başarılıysa kaydeder. */
export async function createGmailAccount(input: AccountInput) {
  await verifyGmail(input.email, input.password);
  return db
    .insert(accounts)
    .values({
      provider: "gmail",
      email: input.email,
      fromName: input.fromName,
      secret: encrypt(input.password.replace(/\s+/g, "")),
      dailyLimit: input.dailyLimit,
      signature: input.signature,
      lastVerifiedAt: new Date(),
    })
    .returning({ id: accounts.id })
    .get();
}

export async function updateAccount(id: number, input: Omit<AccountInput, "password" | "email"> & { password?: string }) {
  const current = getAccount(id);
  if (!current) throw new Error("Hesap bulunamadı");
  const patch: Partial<typeof accounts.$inferInsert> = {
    fromName: input.fromName,
    dailyLimit: input.dailyLimit,
    signature: input.signature,
  };
  if (input.password) {
    if (current.provider !== "gmail") throw new Error("Outlook hesabında şifre yok; yeniden bağlanmak için \"Yeniden bağlan\" kullanın.");
    await verifyGmail(current.email, input.password);
    patch.secret = encrypt(input.password.replace(/\s+/g, ""));
    patch.lastVerifiedAt = new Date();
    patch.lastError = null;
  }
  db.update(accounts).set(patch).where(eq(accounts.id, id)).run();
}

/**
 * OAuth ile bağlanan Outlook hesabını kaydeder. Aynı adres zaten varsa
 * (yeniden bağlanma) yalnızca anahtarı yeniler; ad, imza ve limit korunur.
 */
export function upsertOutlookAccount(p: { email: string; name?: string; refreshToken: string }) {
  const existing = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(sql`${accounts.provider} = 'outlook' AND lower(${accounts.email}) = ${p.email.toLowerCase()}`)
    .get();
  const secret = encodeOutlookSecret(p.refreshToken);
  if (existing) {
    db.update(accounts).set({ secret, lastVerifiedAt: new Date(), lastError: null }).where(eq(accounts.id, existing.id)).run();
    forgetOutlookToken(existing.id);
    return { id: existing.id, created: false };
  }
  const row = db
    .insert(accounts)
    .values({
      provider: "outlook",
      email: p.email.toLowerCase(),
      fromName: p.name?.trim() || p.email.split("@")[0],
      secret,
      // Microsoft net limit yayınlamıyor; yeni kişisel hesaplar hızlı kısıtlanıyor
      dailyLimit: 150,
      lastVerifiedAt: new Date(),
    })
    .returning({ id: accounts.id })
    .get();
  return { id: row.id, created: true };
}

export function setAccountError(id: number, message: string | null) {
  db.update(accounts).set({ lastError: message }).where(eq(accounts.id, id)).run();
}

export function deleteAccount(id: number) {
  // Bu hesabı kullanan çalışan kampanyalar durdurulur
  db.update(schema.campaigns)
    .set({ status: "paused", statusReason: "Gönderen hesap silindi." })
    .where(sql`${schema.campaigns.accountId} = ${id} AND ${schema.campaigns.status} = 'running'`)
    .run();
  db.delete(accounts).where(eq(accounts.id, id)).run();
}
