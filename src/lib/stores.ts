import { and, asc, desc, eq, gte, inArray, like, lte, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Contact, Store } from "@/db/schema";
import { analyzeStore, type AnalysisResult } from "@/lib/analyzer";
import { enqueue } from "@/lib/jobs";
import type { StoreFilters } from "@/lib/store-filters";

const { stores, contacts } = schema;

// ---------------------------------------------------------------------------
// Ekleme / silme / yeniden analiz
// ---------------------------------------------------------------------------

/** Yeni alan adlarını ekler, analiz işlerini sıraya koyar. Var olanları atlar. */
export function addStores(domains: string[], source: string) {
  if (domains.length === 0) return { added: 0, duplicates: 0 };
  const inserted = db.transaction((tx) => {
    const ids: number[] = [];
    for (const domain of domains) {
      const row = tx
        .insert(stores)
        .values({ domain, source })
        .onConflictDoNothing({ target: stores.domain })
        .returning({ id: stores.id })
        .get();
      if (row) ids.push(row.id);
    }
    return ids;
  });
  enqueue(
    "analyze_store",
    inserted.map((storeId) => ({ storeId })),
  );
  return { added: inserted.length, duplicates: domains.length - inserted.length };
}

/** SQLite tek sorguda sınırlı sayıda parametre kabul eder; büyük id listelerini böl. */
function chunked(ids: number[], fn: (part: number[]) => void, size = 500) {
  for (let i = 0; i < ids.length; i += size) fn(ids.slice(i, i + size));
}

export function requeueStores(ids: number[]) {
  if (ids.length === 0) return;
  chunked(ids, (part) =>
    db.update(stores).set({ status: "pending", error: null }).where(inArray(stores.id, part)).run(),
  );
  enqueue(
    "analyze_store",
    ids.map((storeId) => ({ storeId })),
  );
}

export function deleteStores(ids: number[]) {
  chunked(ids, (part) => db.delete(stores).where(inArray(stores.id, part)).run());
}

export function setBrandOverride(id: number, name: string | null) {
  db.update(stores)
    .set({ brandNameOverride: name?.trim() || null })
    .where(eq(stores.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Analiz sonucu kaydetme (worker)
// ---------------------------------------------------------------------------

/** Worker tarafından çağrılır: mağazayı analiz edip sonucu kaydeder. */
export async function runStoreAnalysis(storeId: number) {
  const store = db.select().from(stores).where(eq(stores.id, storeId)).get();
  if (!store) return; // bu arada silinmiş
  db.update(stores).set({ status: "analyzing" }).where(eq(stores.id, storeId)).run();
  const result = await analyzeStore(store.domain);

  // Aynı mağaza başka bir adresle (ör. myshopify adresi ve asıl alan adı) zaten listede mi?
  if (result.myshopifyDomain) {
    const twin = db.$client
      .prepare(`SELECT domain FROM stores WHERE myshopify_domain = ? AND id != ? AND status != 'duplicate' ORDER BY id LIMIT 1`)
      .get(result.myshopifyDomain, storeId) as { domain: string } | undefined;
    if (twin) {
      db.update(stores)
        .set({ status: "duplicate", error: `${twin.domain} ile aynı mağaza`, myshopifyDomain: result.myshopifyDomain, finalUrl: result.finalUrl, analyzedAt: new Date() })
        .where(eq(stores.id, storeId))
        .run();
      db.delete(contacts).where(eq(contacts.storeId, storeId)).run();
      return;
    }
  }
  saveAnalysis(storeId, result);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function saveAnalysis(storeId: number, r: AnalysisResult) {
  const { emails, ...fields } = r;
  db.transaction((tx) => {
    tx.update(stores)
      .set({ ...fields, analyzedAt: new Date() })
      .where(eq(stores.id, storeId))
      .run();

    const existing = tx.select().from(contacts).where(eq(contacts.storeId, storeId)).all();
    const found = new Set(emails.map((e) => e.email));

    // Sitede artık görünmeyen otomatik adresleri sil (elle eklenenler kalır).
    const stale = existing.filter((c) => !c.isManual && !found.has(c.email)).map((c) => c.id);
    if (stale.length) tx.delete(contacts).where(inArray(contacts.id, stale)).run();

    for (const e of emails) {
      tx.insert(contacts)
        .values({ storeId, email: e.email, sourceUrl: e.sourceUrl, mxValid: e.mxValid })
        .onConflictDoUpdate({
          target: [contacts.storeId, contacts.email],
          set: { sourceUrl: e.sourceUrl, mxValid: e.mxValid },
        })
        .run();
    }

    // Birincil: kullanıcının seçtiği (pinned) hâlâ varsa o, yoksa analizin en iyi bulduğu.
    const pinned = existing.find((c) => c.pinned && (c.isManual || found.has(c.email)));
    recomputePrimary(tx, storeId, pinned?.email ?? emails[0]?.email ?? null);
  });
}

function recomputePrimary(tx: Tx, storeId: number, preferred: string | null) {
  tx.update(contacts).set({ isPrimary: false }).where(eq(contacts.storeId, storeId)).run();
  const target =
    preferred ??
    // Tercih yoksa kalan herhangi bir adres (ör. elle eklenmiş)
    tx.select({ email: contacts.email }).from(contacts).where(eq(contacts.storeId, storeId)).limit(1).get()?.email;
  if (target) {
    tx.update(contacts)
      .set({ isPrimary: true })
      .where(and(eq(contacts.storeId, storeId), eq(contacts.email, target)))
      .run();
  }
}

// ---------------------------------------------------------------------------
// İletişim adresleri (detay paneli)
// ---------------------------------------------------------------------------

function pinPrimary(tx: Tx, storeId: number, email: string) {
  tx.update(contacts).set({ pinned: false }).where(eq(contacts.storeId, storeId)).run();
  tx.update(contacts)
    .set({ pinned: true })
    .where(and(eq(contacts.storeId, storeId), eq(contacts.email, email)))
    .run();
  recomputePrimary(tx, storeId, email);
}

export function addManualContact(storeId: number, email: string, mxValid: boolean | null, makePrimary: boolean) {
  db.transaction((tx) => {
    tx.insert(contacts)
      .values({ storeId, email, sourceUrl: "manual", isManual: true, mxValid })
      .onConflictDoUpdate({ target: [contacts.storeId, contacts.email], set: { isManual: true, mxValid } })
      .run();
    const hasPrimary = tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.storeId, storeId), eq(contacts.isPrimary, true)))
      .get();
    if (makePrimary || !hasPrimary) pinPrimary(tx, storeId, email);
  });
}

export function setPrimaryContact(contactId: number) {
  const c = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!c) return;
  db.transaction((tx) => pinPrimary(tx, c.storeId, c.email));
}

export function deleteContact(contactId: number) {
  const c = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!c) return;
  db.transaction((tx) => {
    tx.delete(contacts).where(eq(contacts.id, contactId)).run();
    if (c.isPrimary) recomputePrimary(tx, c.storeId, null);
  });
}

// ---------------------------------------------------------------------------
// Listeleme, filtreleme, sayfalama
// ---------------------------------------------------------------------------

export type StoreRow = Store & {
  primaryEmail: string | null;
  primaryMx: boolean | null;
  emailCount: number;
};

// ÖNEMLİ: Drizzle, tek tablolu sorgularda ${stores.id} ifadesini tablo adı olmadan ("id") yazar.
// Alt sorgularda bu, contacts.id'ye bağlanır. Bu yüzden alt sorgularda "stores.id" açıkça yazılıyor.
const HAS_EMAIL = sql`EXISTS (SELECT 1 FROM contacts c WHERE c.store_id = stores.id)`;
const HAS_VALID_PRIMARY = sql`EXISTS (SELECT 1 FROM contacts c WHERE c.store_id = stores.id AND c.is_primary = 1 AND c.mx_valid IS NOT 0)`;

const WAS_CONTACTED = sql`EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.store_id = stores.id AND r.status = 'sent')`;

/** Filtreleri SQL koşuluna çevirir. */
export function buildWhere(f: StoreFilters): SQL | undefined {
  const conds: (SQL | undefined)[] = [];

  if (f.q) {
    const pattern = `%${f.q.toLowerCase()}%`;
    conds.push(
      or(
        like(stores.domain, pattern),
        sql`lower(coalesce(${stores.brandNameOverride}, ${stores.brandName}, '')) LIKE ${pattern}`,
        sql`EXISTS (SELECT 1 FROM contacts c WHERE c.store_id = stores.id AND c.email LIKE ${pattern})`,
      ),
    );
  }
  if (f.status?.length) conds.push(inArray(stores.status, f.status));
  if (f.country?.length) conds.push(inArray(stores.country, f.country));
  if (f.language?.length) conds.push(inArray(stores.language, f.language));
  if (f.currency?.length) conds.push(inArray(stores.currency, f.currency));
  if (f.source?.length) conds.push(inArray(stores.source, f.source));
  if (f.app?.length) {
    const values = sql.join(
      f.app.map((a) => sql`${a}`),
      sql`, `,
    );
    conds.push(sql`EXISTS (SELECT 1 FROM json_each(stores.apps) j WHERE j.value IN (${values}))`);
  }
  if (f.category) conds.push(sql`lower(${stores.category}) LIKE ${`%${f.category.toLowerCase()}%`}`);
  if (f.email === "yes") conds.push(HAS_EMAIL);
  if (f.email === "valid") conds.push(HAS_VALID_PRIMARY);
  if (f.email === "no") conds.push(sql`NOT ${HAS_EMAIL}`);
  if (f.contacted === "yes") conds.push(WAS_CONTACTED);
  if (f.contacted === "no") conds.push(sql`NOT ${WAS_CONTACTED}`);
  if (f.minProducts !== undefined) conds.push(gte(stores.productCount, f.minProducts));
  if (f.maxProducts !== undefined) conds.push(lte(stores.productCount, f.maxProducts));
  if (f.minTr !== undefined) conds.push(gte(stores.trScore, f.minTr));
  if (f.activeDays) conds.push(gte(stores.lastProductAt, new Date(Date.now() - f.activeDays * 86_400_000)));

  return and(...conds.filter(Boolean));
}

function orderBy(f: StoreFilters): SQL[] {
  const dir = f.dir === "asc" ? asc : desc;
  // Boş değerler her iki yönde de en sona gelsin
  const nullsLast = (col: SQL) => [sql`${col} IS NULL`, dir(col)];
  switch (f.sort) {
    case "brand":
      return nullsLast(sql`lower(coalesce(${stores.brandNameOverride}, ${stores.brandName}))`);
    case "products":
      return nullsLast(sql`${stores.productCount}`);
    case "lastProduct":
      return nullsLast(sql`${stores.lastProductAt}`);
    case "country":
      return nullsLast(sql`${stores.country}`);
    case "price":
      return nullsLast(sql`${stores.priceMin}`);
    case "created":
      return [dir(stores.createdAt), desc(stores.id)];
    case "tr":
    default:
      return [dir(stores.trScore), sql`${stores.analyzedAt} IS NULL`, desc(stores.analyzedAt), desc(stores.id)];
  }
}

export function queryStores(f: StoreFilters): { rows: StoreRow[]; total: number } {
  const where = buildWhere(f);
  const total = db.select({ n: sql<number>`COUNT(*)` }).from(stores).where(where).get()?.n ?? 0;
  const rows = db
    .select({
      store: stores,
      primaryEmail: sql<string | null>`(SELECT email FROM contacts c WHERE c.store_id = stores.id AND c.is_primary = 1)`,
      primaryMx: sql<number | null>`(SELECT mx_valid FROM contacts c WHERE c.store_id = stores.id AND c.is_primary = 1)`,
      emailCount: sql<number>`(SELECT COUNT(*) FROM contacts c WHERE c.store_id = stores.id)`,
    })
    .from(stores)
    .where(where)
    .orderBy(...orderBy(f))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize)
    .all()
    .map(({ store, primaryEmail, primaryMx, emailCount }) => ({
      ...store,
      primaryEmail,
      primaryMx: primaryMx === null ? null : Boolean(primaryMx),
      emailCount,
    }));
  return { rows, total };
}

/** "Filtreye uyan tümünü seç" için. */
export function queryStoreIds(f: StoreFilters): number[] {
  return db
    .select({ id: stores.id })
    .from(stores)
    .where(buildWhere(f))
    .all()
    .map((r) => r.id);
}

/** CSV dışa aktarımı için tüm eşleşen satırlar (sayfalamasız). */
export function queryStoresForExport(f: StoreFilters): StoreRow[] {
  return queryStores({ ...f, page: 1, pageSize: 1_000_000 }).rows;
}

export type Facet = { value: string; count: number };
export type StoreFacets = Record<"country" | "language" | "currency" | "app" | "source", Facet[]>;

/** Filtre menülerindeki seçenekler ve sayıları (tüm tablo üzerinden). */
export function storeFacets(): StoreFacets {
  const group = (col: "country" | "language" | "currency" | "source") =>
    db.$client
      .prepare(
        `SELECT ${col} AS value, COUNT(*) AS count FROM stores
         WHERE ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY count DESC, value`,
      )
      .all() as Facet[];
  return {
    country: group("country"),
    language: group("language"),
    currency: group("currency"),
    source: group("source"),
    app: db.$client
      .prepare(`SELECT j.value AS value, COUNT(*) AS count FROM stores, json_each(stores.apps) j GROUP BY j.value ORDER BY count DESC, value`)
      .all() as Facet[],
  };
}

export function storeStats() {
  return db
    .select({
      total: sql<number>`COUNT(*)`,
      pending: sql<number>`COALESCE(SUM(status IN ('pending','analyzing')), 0)`,
      shopify: sql<number>`COALESCE(SUM(status IN ('done','password')), 0)`,
      withEmail: sql<number>`COALESCE(SUM(${HAS_EMAIL}), 0)`,
      turkish: sql<number>`COALESCE(SUM(tr_score >= 40), 0)`,
    })
    .from(stores)
    .get()!;
}

export function getStoreDetail(id: number): { store: Store; contacts: Contact[] } | null {
  const store = db.select().from(stores).where(eq(stores.id, id)).get();
  if (!store) return null;
  const list = db
    .select()
    .from(contacts)
    .where(eq(contacts.storeId, id))
    .orderBy(desc(contacts.isPrimary), asc(contacts.id))
    .all();
  return { store, contacts: list };
}
