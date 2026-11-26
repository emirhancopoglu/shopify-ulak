import type { StoreStatus } from "@/db/schema";

export const STATUS_LABEL: Record<StoreStatus, { label: string; cls: string }> = {
  pending: { label: "Sırada", cls: "bg-stone-100 text-stone-600" },
  analyzing: { label: "Analiz ediliyor", cls: "bg-amber-100 text-amber-800 animate-pulse" },
  // `done` = analizi biten her site (Shopify ya da genel); platform ayrı sütunda gösterilir
  done: { label: "Analiz edildi", cls: "bg-emerald-100 text-emerald-800" },
  password: { label: "Şifreli", cls: "bg-violet-100 text-violet-800" },
  not_shopify: { label: "Shopify değil", cls: "bg-stone-200 text-stone-600" },
  unreachable: { label: "Açılmadı", cls: "bg-red-100 text-red-800" },
  error: { label: "Hata", cls: "bg-red-100 text-red-800" },
  duplicate: { label: "Kopya", cls: "bg-stone-100 text-stone-500 line-through" },
};

const regionNames = new Intl.DisplayNames(["tr"], { type: "region" });
const languageNames = new Intl.DisplayNames(["tr"], { type: "language" });
const relTime = new Intl.RelativeTimeFormat("tr", { numeric: "auto" });

export function flag(code: string | null | undefined) {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return "";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function countryName(code: string | null | undefined) {
  if (!code) return "—";
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function countryLabel(code: string | null | undefined) {
  if (!code) return "—";
  return `${flag(code)} ${countryName(code)}`.trim();
}

export function languageLabel(code: string | null | undefined) {
  if (!code) return "—";
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function money(n: number, currency: string | null) {
  try {
    return new Intl.NumberFormat("tr-TR", {
      style: currency ? "currency" : "decimal",
      currency: currency ?? undefined,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return n.toFixed(0);
  }
}

export function priceRange(min: number | null, max: number | null, currency: string | null) {
  if (min === null || max === null) return "—";
  return min === max ? money(min, currency) : `${money(min, currency)} – ${money(max, currency)}`;
}

export function timeAgo(d: Date | string | null, now: number) {
  if (!d) return "—";
  const days = Math.round((new Date(d).getTime() - now) / 86_400_000);
  if (Math.abs(days) < 1) return "bugün";
  if (Math.abs(days) < 31) return relTime.format(days, "day");
  if (Math.abs(days) < 365) return relTime.format(Math.round(days / 30), "month");
  return relTime.format(Math.round(days / 365), "year");
}

/** Sunucu bileşenlerinde "şimdi" (render saflığı kuralı nedeniyle ayrı fonksiyon). */
export const nowMs = () => Date.now();

export const fmtInt =(n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("tr-TR"));
