/**
 * Mağaza listesi filtreleri. URL query string'inde tutulur (paylaşılabilir, yenilemede kaybolmaz).
 * Bu dosya hem sunucu hem tarayıcı tarafında kullanılır; veritabanı import'u içermemeli.
 */
import { STORE_STATUSES, type StoreStatus } from "@/db/schema";

export const SORT_KEYS = ["tr", "brand", "products", "lastProduct", "created", "country", "price"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const EMAIL_FILTERS = ["yes", "valid", "no"] as const;
export type EmailFilter = (typeof EMAIL_FILTERS)[number];

export const CONTACTED_FILTERS = ["yes", "no"] as const;
export type ContactedFilter = (typeof CONTACTED_FILTERS)[number];

/** yes: en az bir eksik var · no: analiz edildi, eksik yok · unanalyzed: eksik kontrollerinden önce analiz edilmiş */
export const FINDING_FILTERS = ["yes", "no", "unanalyzed"] as const;
export type FindingFilter = (typeof FINDING_FILTERS)[number];

export const PAGE_SIZES = [50, 100, 200] as const;

export type StoreFilters = {
  q?: string;
  status?: StoreStatus[];
  country?: string[];
  language?: string[];
  currency?: string[];
  app?: string[];
  source?: string[];
  category?: string;
  email?: EmailFilter;
  /** Herhangi bir kampanyada mail gönderildi mi */
  contacted?: ContactedFilter;
  /** Mağaza eksikleri (bulgu) var mı */
  findings?: FindingFilter;
  minProducts?: number;
  maxProducts?: number;
  minTr?: number;
  activeDays?: number;
  sort: SortKey;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export const DEFAULT_FILTERS: StoreFilters = { sort: "tr", dir: "desc", page: 1, pageSize: 50 };

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function get(p: Params, key: string): string | undefined {
  const v = p instanceof URLSearchParams ? p.get(key) : p[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

const list = (p: Params, key: string) =>
  get(p, key)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const num = (p: Params, key: string) => {
  const n = Number(get(p, key));
  return get(p, key) !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
};

const oneOf = <T extends string>(values: readonly T[], v: string | undefined) =>
  values.includes(v as T) ? (v as T) : undefined;

export function parseFilters(p: Params): StoreFilters {
  const pageSize = num(p, "size");
  return {
    q: get(p, "q"),
    status: list(p, "status")?.filter((s): s is StoreStatus => (STORE_STATUSES as readonly string[]).includes(s)),
    country: list(p, "country")?.map((c) => c.toUpperCase()),
    language: list(p, "lang")?.map((c) => c.toLowerCase()),
    currency: list(p, "cur")?.map((c) => c.toUpperCase()),
    app: list(p, "app"),
    source: list(p, "source"),
    category: get(p, "cat"),
    email: oneOf(EMAIL_FILTERS, get(p, "email")),
    contacted: oneOf(CONTACTED_FILTERS, get(p, "sent")),
    findings: oneOf(FINDING_FILTERS, get(p, "bulgu")),
    minProducts: num(p, "pmin"),
    maxProducts: num(p, "pmax"),
    minTr: num(p, "tr"),
    activeDays: num(p, "active"),
    sort: oneOf(SORT_KEYS, get(p, "sort")) ?? DEFAULT_FILTERS.sort,
    dir: get(p, "dir") === "asc" ? "asc" : "desc",
    page: Math.max(1, Math.floor(num(p, "page") ?? 1)),
    pageSize: PAGE_SIZES.includes(pageSize as (typeof PAGE_SIZES)[number]) ? pageSize! : DEFAULT_FILTERS.pageSize,
  };
}

export function serializeFilters(f: Partial<StoreFilters>): URLSearchParams {
  const p = new URLSearchParams();
  const set = (k: string, v: string | number | undefined) => {
    if (v !== undefined && v !== "") p.set(k, String(v));
  };
  const setList = (k: string, v: string[] | undefined) => {
    if (v?.length) p.set(k, v.join(","));
  };
  set("q", f.q);
  setList("status", f.status);
  setList("country", f.country);
  setList("lang", f.language);
  setList("cur", f.currency);
  setList("app", f.app);
  setList("source", f.source);
  set("cat", f.category);
  set("email", f.email);
  set("sent", f.contacted);
  set("bulgu", f.findings);
  set("pmin", f.minProducts);
  set("pmax", f.maxProducts);
  set("tr", f.minTr);
  set("active", f.activeDays);
  if (f.sort && f.sort !== DEFAULT_FILTERS.sort) set("sort", f.sort);
  if (f.dir && f.dir !== DEFAULT_FILTERS.dir) set("dir", f.dir);
  if (f.page && f.page > 1) set("page", f.page);
  if (f.pageSize && f.pageSize !== DEFAULT_FILTERS.pageSize) set("size", f.pageSize);
  return p;
}

/** Sayfalama/sıralama dışında aktif filtre sayısı. */
export function activeFilterCount(f: StoreFilters): number {
  return [
    f.q,
    f.status?.length,
    f.country?.length,
    f.language?.length,
    f.currency?.length,
    f.app?.length,
    f.source?.length,
    f.category,
    f.email,
    f.contacted,
    f.findings,
    f.minProducts,
    f.maxProducts,
    f.minTr,
    f.activeDays,
  ].filter((v) => v !== undefined && v !== 0 && v !== "").length;
}
