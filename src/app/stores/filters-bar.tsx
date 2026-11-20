"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useState, useTransition } from "react";
import { MultiSelect } from "@/components/multi-select";
import { STORE_STATUSES } from "@/db/schema";
import { countryName, flag, languageLabel, STATUS_LABEL } from "@/lib/format";
import { activeFilterCount, DEFAULT_FILTERS, serializeFilters, type StoreFilters } from "@/lib/store-filters";
import type { StoreFacets } from "@/lib/stores";

const TR_OPTIONS = [
  { value: "", label: "Tümü" },
  { value: "15", label: "≥ 15 (bir işaret)" },
  { value: "40", label: "≥ 40 (Türkiye odaklı)" },
  { value: "60", label: "≥ 60 (kesin TR)" },
];

const ACTIVE_OPTIONS = [
  { value: "", label: "Tümü" },
  { value: "30", label: "Son 30 gün" },
  { value: "90", label: "Son 90 gün" },
  { value: "180", label: "Son 6 ay" },
  { value: "365", label: "Son 1 yıl" },
];

const EMAIL_OPTIONS = [
  { value: "", label: "Tümü" },
  { value: "yes", label: "Var" },
  { value: "valid", label: "Var ve geçerli (MX)" },
  { value: "no", label: "Yok" },
];

const CONTACTED_OPTIONS = [
  { value: "", label: "Tümü" },
  { value: "no", label: "Henüz atılmadı" },
  { value: "yes", label: "Atıldı" },
];

const SOURCE_LABEL: Record<string, string> = { manual: "Elle", test: "Test", search: "Arama", commoncrawl: "Common Crawl", dns: "DNS listesi" };

export function FiltersBar({ filters, facets, total }: { filters: StoreFilters; facets: StoreFacets; total: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Yazarken her tuşta sayfa yenilenmesin diye metin alanları yerel tutulur.
  const [q, setQ] = useState(filters.q ?? "");
  const [category, setCategory] = useState(filters.category ?? "");
  const [pmin, setPmin] = useState(filters.minProducts?.toString() ?? "");
  const [pmax, setPmax] = useState(filters.maxProducts?.toString() ?? "");

  const apply = (patch: Partial<StoreFilters>) => {
    const next = { ...filters, ...patch, page: 1 };
    startTransition(() => router.push(`/stores?${serializeFilters(next)}`, { scroll: false }));
  };

  // Metin alanları: yazmayı bıraktıktan 400 ms sonra uygula
  const applyText = useEffectEvent((patch: Partial<StoreFilters>) => apply(patch));
  useEffect(() => {
    const value = q.trim() || undefined;
    const cat = category.trim() || undefined;
    if (value === filters.q && cat === filters.category) return;
    const t = setTimeout(() => applyText({ q: value, category: cat }), 400);
    return () => clearTimeout(t);
  }, [q, category, filters.q, filters.category]);

  const applyProducts = () => {
    const toNum = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? undefined : Math.max(0, Number(s)));
    const minProducts = toNum(pmin);
    const maxProducts = toNum(pmax);
    if (minProducts !== filters.minProducts || maxProducts !== filters.maxProducts) apply({ minProducts, maxProducts });
  };

  const clearAll = () => {
    setQ("");
    setCategory("");
    setPmin("");
    setPmax("");
    startTransition(() =>
      router.push(`/stores?${serializeFilters({ ...DEFAULT_FILTERS, sort: filters.sort, dir: filters.dir, pageSize: filters.pageSize })}`, {
        scroll: false,
      }),
    );
  };

  const count = activeFilterCount(filters);
  // Türkiye her zaman listenin başında
  const countryOptions = [...facets.country]
    .sort((a, b) => Number(b.value === "TR") - Number(a.value === "TR"))
    .map((f) => ({ value: f.value, label: `${flag(f.value)} ${countryName(f.value)}`, count: f.count }));

  const presetActive = {
    tr: filters.minTr === 40,
    ready: filters.email === "valid" && filters.contacted === "no" && filters.status?.length === 1 && filters.status[0] === "done",
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ara: alan adı, marka, mail…"
          className="h-8 w-64 rounded-md border border-stone-300 px-2.5 outline-none focus:border-stone-500"
        />
        <span className="mx-1 h-5 w-px bg-stone-200" />
        <span className="text-xs text-stone-500">Hazır filtreler:</span>
        <Preset active={presetActive.tr} onClick={() => apply({ minTr: presetActive.tr ? undefined : 40 })}>
          🇹🇷 Türkiye odaklı
        </Preset>
        <Preset
          active={presetActive.ready}
          onClick={() =>
            presetActive.ready
              ? apply({ email: undefined, status: undefined, contacted: undefined })
              : apply({ email: "valid", status: ["done"], contacted: "no" })
          }
        >
          ✉ Gönderime hazır
        </Preset>
        <Preset active={filters.activeDays === 90} onClick={() => apply({ activeDays: filters.activeDays === 90 ? undefined : 90 })}>
          Aktif (90 gün)
        </Preset>
        <div className="ml-auto flex items-center gap-3">
          {isPending && <span className="text-xs text-stone-400">yükleniyor…</span>}
          <span className="text-stone-500">
            <b className="text-stone-900 tabular-nums">{total.toLocaleString("tr-TR")}</b> sonuç
          </span>
          {count > 0 && (
            <button onClick={clearAll} className="text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline">
              Filtreleri temizle ({count})
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <MultiSelect
          label="Durum"
          value={filters.status ?? []}
          onChange={(v) => apply({ status: v as StoreFilters["status"] })}
          options={STORE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s].label }))}
        />
        <MultiSelect
          label="Ülke"
          value={filters.country ?? []}
          onChange={(v) => apply({ country: v })}
          options={countryOptions}
          emptyText="Henüz analiz edilmiş mağaza yok"
        />
        <MultiSelect
          label="Dil"
          value={filters.language ?? []}
          onChange={(v) => apply({ language: v })}
          options={facets.language.map((f) => ({ value: f.value, label: `${languageLabel(f.value)} (${f.value})`, count: f.count }))}
        />
        <MultiSelect
          label="Para birimi"
          value={filters.currency ?? []}
          onChange={(v) => apply({ currency: v })}
          options={facets.currency.map((f) => ({ value: f.value, label: f.value, count: f.count }))}
        />
        <MultiSelect
          label="Uygulama"
          value={filters.app ?? []}
          onChange={(v) => apply({ app: v })}
          options={facets.app.map((f) => ({ value: f.value, label: f.value, count: f.count }))}
        />
        {facets.source.length > 1 && (
          <MultiSelect
            label="Kaynak"
            value={filters.source ?? []}
            onChange={(v) => apply({ source: v })}
            options={facets.source.map((f) => ({ value: f.value, label: SOURCE_LABEL[f.value] ?? f.value, count: f.count }))}
          />
        )}

        <Select label="Mail" value={filters.email ?? ""} options={EMAIL_OPTIONS} onChange={(v) => apply({ email: (v || undefined) as StoreFilters["email"] })} />
        <Select
          label="Mail atıldı"
          value={filters.contacted ?? ""}
          options={CONTACTED_OPTIONS}
          onChange={(v) => apply({ contacted: (v || undefined) as StoreFilters["contacted"] })}
        />
        <Select label="TR puanı" value={filters.minTr?.toString() ?? ""} options={TR_OPTIONS} onChange={(v) => apply({ minTr: v ? Number(v) : undefined })} />
        <Select
          label="Son ürün"
          value={filters.activeDays?.toString() ?? ""}
          options={ACTIVE_OPTIONS}
          onChange={(v) => apply({ activeDays: v ? Number(v) : undefined })}
        />

        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Kategori içerir…"
          className="h-8 w-40 rounded-md border border-stone-300 px-2.5 outline-none focus:border-stone-500"
        />

        <div className="flex h-8 items-center rounded-md border border-stone-300 bg-white px-2.5">
          <span className="mr-2 text-stone-500">Ürün</span>
          {[
            { v: pmin, set: setPmin, ph: "min" },
            { v: pmax, set: setPmax, ph: "max" },
          ].map(({ v, set, ph }, i) => (
            <span key={ph} className="flex items-center">
              {i === 1 && <span className="mx-1 text-stone-400">–</span>}
              <input
                value={v}
                inputMode="numeric"
                onChange={(e) => set(e.target.value.replace(/\D/g, ""))}
                onBlur={applyProducts}
                onKeyDown={(e) => e.key === "Enter" && applyProducts()}
                placeholder={ph}
                className="w-12 bg-transparent text-center outline-none"
              />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Preset({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 rounded-full border px-3 text-[13px] ${
        active ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
      }`}
    >
      {children}
    </button>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label
      className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 ${
        value ? "border-stone-800 bg-stone-900 text-white" : "border-stone-300 bg-white"
      }`}
    >
      <span className={value ? "text-stone-300" : "text-stone-500"}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-transparent font-medium outline-none [&>option]:text-stone-900">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
