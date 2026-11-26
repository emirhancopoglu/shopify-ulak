import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

/** Mağaza eksiği (analizör bulgusu). Şema bağımsız tutmak için analizörden kopyalanmış tip. */
export type StoreFinding = { key: string; label: string; detail: string; sentence: string };

export const STORE_STATUSES = [
  "pending", // sırada, henüz analiz edilmedi
  "analyzing",
  "done", // Shopify mağazası, analiz tamam
  "not_shopify",
  "password", // şifre korumalı (açılmamış) mağaza
  "unreachable", // site açılmadı
  "error",
  "duplicate", // başka bir kayıtla aynı mağaza (aynı myshopify adresi)
] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

/** Sitenin yazılım platformu (F6). "unknown" = sinyal bulunamadı; null = henüz tespit edilmedi. */
export const PLATFORMS = [
  "shopify",
  "nextjs",
  "react",
  "angular",
  "vue",
  "nuxt",
  "wordpress",
  "wix",
  "webflow",
  "ticimax",
  "ikas",
  "ideasoft",
  "unknown",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_CONFIDENCES = ["high", "medium", "low"] as const;
export type PlatformConfidence = (typeof PLATFORM_CONFIDENCES)[number];

/** Platform tespitinin dayanakları (kullanıcıya gösterilir, hata ayıklamada kullanılır). */
export type PlatformEvidence = { confidence: PlatformConfidence; signals: string[] };

export const stores = sqliteTable(
  "stores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    domain: text("domain").notNull(), // normalize edilmiş, www'siz host
    finalUrl: text("final_url"),
    myshopifyDomain: text("myshopify_domain"),
    status: text("status", { enum: STORE_STATUSES }).notNull().default("pending"),
    error: text("error"),
    source: text("source").notNull().default("manual"),
    /** Yazılım platformu (F6). null = henüz tespit edilmedi. */
    platform: text("platform", { enum: PLATFORMS }),
    platformEvidence: text("platform_evidence", { mode: "json" }).$type<PlatformEvidence>(),

    brandName: text("brand_name"), // meta.json'dan otomatik
    brandNameOverride: text("brand_name_override"), // elle düzeltilmiş
    description: text("description"),
    country: text("country"),
    province: text("province"),
    city: text("city"),
    currency: text("currency"),
    language: text("language"),
    category: text("category"),
    productCount: integer("product_count"),
    priceMin: real("price_min"),
    priceMax: real("price_max"),
    lastProductAt: integer("last_product_at", { mode: "timestamp_ms" }),
    themeName: text("theme_name"),
    apps: text("apps", { mode: "json" }).$type<string[]>(),
    socials: text("socials", { mode: "json" }).$type<Record<string, string>>(),
    /** Öncelik sıralı mağaza eksikleri (analizör üretir). null = bu özellikten önce analiz edilmiş. */
    findings: text("findings", { mode: "json" }).$type<StoreFinding[]>(),
    trScore: integer("tr_score").notNull().default(0),

    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    analyzedAt: integer("analyzed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("stores_domain_uq").on(t.domain),
    index("stores_status_idx").on(t.status),
    index("stores_tr_score_idx").on(t.trScore),
  ],
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    storeId: integer("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    sourceUrl: text("source_url"),
    mxValid: integer("mx_valid", { mode: "boolean" }),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    /** Kullanıcı elle ekledi; yeniden analizde silinmez. */
    isManual: integer("is_manual", { mode: "boolean" }).notNull().default(false),
    /** Kullanıcı birincil olarak seçti; yeniden analiz bu seçimi bozmaz. */
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("contacts_store_email_uq").on(t.storeId, t.email)],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    runAfter: integer("run_after", { mode: "timestamp_ms" }).notNull().default(now),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("jobs_status_run_after_idx").on(t.status, t.runAfter)],
);

/** Basit anahtar-değer tablosu (worker heartbeat, ayarlar vb.) */
export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
});

// ---------------------------------------------------------------------------
// Gönderim (F3)
// ---------------------------------------------------------------------------

export const TEMPLATE_FORMATS = ["text", "html"] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];

/**
 * Şablonun hedef kitlesi (F6 Faz 5). Kampanya, uymayan alıcılar kuyruktayken başlatılamaz:
 * Shopify tanıtım metni Next.js/WordPress sitesine gitmesin diye.
 * all = herkese uyar · shopify · general (Shopify dışı tüm siteler) · js (Next.js/React/Angular/Vue/Nuxt) · wordpress
 */
export const TEMPLATE_AUDIENCES = ["all", "shopify", "general", "js", "wordpress"] as const;
export type TemplateAudience = (typeof TEMPLATE_AUDIENCES)[number];

export const templates = sqliteTable("templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  format: text("format", { enum: TEMPLATE_FORMATS }).notNull().default("text"),
  audience: text("audience", { enum: TEMPLATE_AUDIENCES }).notNull().default("all"),
  subject: text("subject").notNull(),
  /** Düz metin gövde (format=text) ya da HTML'in düz metin alternatifi (boşsa HTML'den üretilir). */
  bodyText: text("body_text").notNull().default(""),
  /** format=html iken kullanılır. */
  bodyHtml: text("body_html"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
});

export const ACCOUNT_PROVIDERS = ["gmail", "outlook", "smtp"] as const;

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider", { enum: ACCOUNT_PROVIDERS }).notNull(),
  email: text("email").notNull(),
  fromName: text("from_name").notNull(),
  /** AES-256-GCM ile şifreli. Gmail: uygulama şifresi; Outlook: {"refreshToken"} JSON; smtp (kurumsal): {host,port,secure,user,password} JSON. Anahtar: data/secret.key */
  secret: text("secret").notNull(),
  /** Kayan 24 saatlik pencerede en fazla gönderim. */
  dailyLimit: integer("daily_limit").notNull().default(400),
  signature: text("signature").notNull().default(""),
  lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
});

export const CAMPAIGN_STATUSES = ["draft", "running", "paused", "completed", "stopped"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    status: text("status", { enum: CAMPAIGN_STATUSES }).notNull().default("draft"),
    /** Duraklatılma sebebi (günlük limit, kimlik hatası vb.), kullanıcıya gösterilir. */
    statusReason: text("status_reason"),
    templateId: integer("template_id").references(() => templates.id, { onDelete: "set null" }),
    accountId: integer("account_id").references(() => accounts.id, { onDelete: "set null" }),
    perHour: integer("per_hour").notNull().default(20),
    // Başlatıldığı andaki şablonun kopyası: çalışırken şablon düzenlenirse kampanya etkilenmez.
    format: text("format", { enum: TEMPLATE_FORMATS }),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    nextSendAt: integer("next_send_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("campaigns_status_idx").on(t.status)],
);

export const RECIPIENT_STATUSES = ["queued", "sending", "sent", "failed", "skipped"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const campaignRecipients = sqliteTable(
  "campaign_recipients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    storeId: integer("store_id").references(() => stores.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    /** Şablon değişkenleri; kampanyaya eklenirken mağazadan kopyalanır, sonra elle düzeltilebilir. */
    vars: text("vars", { mode: "json" }).$type<Record<string, string>>().notNull(),
    status: text("status", { enum: RECIPIENT_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    messageId: text("message_id"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("recipients_campaign_email_uq").on(t.campaignId, t.email),
    index("recipients_campaign_status_idx").on(t.campaignId, t.status),
    index("recipients_sent_at_idx").on(t.sentAt),
    index("recipients_email_idx").on(t.email),
  ],
);

/** Asla mail atılmayacak adresler (çıkmak isteyen, geri dönen, elle engellenen). */
export const suppression = sqliteTable("suppression", {
  email: text("email").primaryKey(),
  reason: text("reason").notNull(), // "unsubscribe" | "bounce" | "manual"
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
});

// ---------------------------------------------------------------------------
// Keşif (F4)
// ---------------------------------------------------------------------------

/** Shopify kaynakları ilk 6; genel site kaynakları (F6 Faz 3) son 2. Gruplar src/lib/discovery/source-groups.ts'te. */
export const DISCOVERY_SOURCES = ["search", "commoncrawl", "dns", "ccdomains", "tranco", "wayback", "general_ccdomains", "general_tranco"] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];
export const DISCOVERY_STATUSES = ["queued", "running", "done", "failed", "cancelled", "blocked"] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

export type DiscoveryStats = {
  total: number; // işlenecek toplam birim (sorgu / sayfa / alan adı)
  cursor: number; // kaldığı yer (devam ettirmek için)
  candidates: number; // bulunan benzersiz aday adres
  known: number; // zaten listede olan
  shopify: number; // Shopify olduğu doğrulanan
  matched: number; // filtreye uyan (ör. Türk)
  added: number; // listeye eklenen
  /** Genel site kaynakları: DNS'te yok ya da ana sayfa açılmadı */
  dead?: number;
  /** Genel site kaynakları: popüler (Tranco ilk 1 milyon) olduğu için elenen */
  popular?: number;
  /** Genel site kaynakları: hedef dışı tür (haber, avukat, kamu) olduğu için elenen */
  excluded?: number;
  /** Otomatik bekleme bitişi (ms). Doluysa çalıştırma bekliyor; worker yeniden başlasa da süre korunur. */
  waitUntil?: number | null;
  waitReason?: string | null;
  /** Art arda engel sayısı (bekleme süresini büyütmek için; yeniden başlamada korunur) */
  blockStreak?: number;
  /** Çalışırken gösterilecek ara durum (ör. "Liste indiriliyor: %40") */
  note?: string | null;
};

export const discoveryRuns = sqliteTable("discovery_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source", { enum: DISCOVERY_SOURCES }).notNull(),
  status: text("status", { enum: DISCOVERY_STATUSES }).notNull().default("queued"),
  /** Kaynağa göre parametreler (kelimeler, dizin, alan adları, trOnly …) */
  params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  stats: text("stats", { mode: "json" }).$type<DiscoveryStats>().notNull(),
  /** Son olaylar (en yeni sonda), arayüzde gösterilir */
  log: text("log", { mode: "json" }).$type<string[]>().notNull(),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

export type DiscoveryRun = typeof discoveryRuns.$inferSelect;

export type Store = typeof stores.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
