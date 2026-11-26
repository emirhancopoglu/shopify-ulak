"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { countryLabel, fmtInt, priceRange, STATUS_LABEL, timeAgo } from "@/lib/format";
import { effectivePlatform, PLATFORM_LABEL } from "@/lib/platform-labels";
import { PAGE_SIZES, serializeFilters, type SortKey, type StoreFilters } from "@/lib/store-filters";
import type { StoreRow } from "@/lib/stores";
import { createCampaignAction } from "../campaigns/actions";
import { deleteAction, reanalyzeAction, renameBrandAction, type BulkTarget } from "./actions";

export function StoresTable({
  rows,
  total,
  filters,
  now,
}: {
  rows: StoreRow[];
  total: number;
  filters: StoreFilters;
  now: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  const href = (patch: Partial<StoreFilters>, extra?: Record<string, string>) => {
    const p = serializeFilters({ ...filters, ...patch });
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    return `/stores?${p}`;
  };

  const pageIds = rows.map((r) => r.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectionCount = allMatching ? total : selected.size;

  const togglePage = () => {
    setAllMatching(false);
    setSelected((s) => {
      const n = new Set(s);
      for (const id of pageIds) {
        if (pageAllSelected) n.delete(id);
        else n.add(id);
      }
      return n;
    });
  };

  const toggle = (id: number) => {
    setAllMatching(false);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(false);
  };

  const target = (): BulkTarget =>
    allMatching ? { filter: serializeFilters({ ...filters, page: 1 }).toString() } : { ids: [...selected] };

  const bulk = (fn: (t: BulkTarget) => Promise<number>, verb: string, confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    startTransition(async () => {
      const n = await fn(target());
      clearSelection();
      setNotice(`${n.toLocaleString("tr-TR")} mağaza ${verb}.`);
    });
  };

  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  // Ürün/fiyat/kategori/eksik sütunları yalnızca Shopify içindir; "Genel siteler" görünümünde boş kalır, gizlenir.
  const showShopifyColumns = filters.kind !== "genel";

  return (
    <section className="rounded-lg border border-stone-200 bg-white">
      {/* Araç çubuğu */}
      <div className="flex min-h-12 flex-wrap items-center gap-3 border-b border-stone-200 px-4 py-2">
        {selectionCount > 0 ? (
          <>
            <span className="font-medium">{selectionCount.toLocaleString("tr-TR")} seçili</span>
            <button
              disabled={isPending}
              onClick={() => bulk(reanalyzeAction, "yeniden analiz sırasına alındı")}
              className="rounded-md border border-stone-300 px-3 py-1 hover:bg-stone-50 disabled:opacity-40"
            >
              Yeniden analiz et
            </button>
            <button
              disabled={isPending}
              onClick={() => bulk(deleteAction, "silindi", `${selectionCount.toLocaleString("tr-TR")} mağaza silinsin mi? Bu geri alınamaz.`)}
              className="rounded-md border border-red-200 px-3 py-1 text-red-700 hover:bg-red-50 disabled:opacity-40"
            >
              Sil
            </button>
            <button
              disabled={isPending}
              onClick={() =>
                confirm(
                  `${selectionCount.toLocaleString("tr-TR")} mağazadan kampanya taslağı oluşturulsun mu?\n\nMaili olmayan, MX kaydı olmayan, kara listedeki ve daha önce mail atılmış adresler otomatik elenir. Gönderim siz başlatana kadar başlamaz.`,
                ) && startTransition(() => createCampaignAction(target()))
              }
              className="rounded-md bg-stone-900 px-3 py-1 font-medium text-white hover:bg-stone-700 disabled:opacity-40"
            >
              ✉ Kampanya oluştur
            </button>
            <button onClick={clearSelection} className="ml-auto text-stone-500 hover:text-stone-800">
              Seçimi temizle
            </button>
          </>
        ) : (
          <>
            <span className="text-stone-500">{notice ?? "Satır seçerek toplu işlem yapabilirsiniz."}</span>
            <a
              href={`/stores/export?${serializeFilters({ ...filters, page: 1 })}`}
              className="ml-auto rounded-md border border-stone-300 px-3 py-1 hover:bg-stone-50"
              download
            >
              CSV indir ({total.toLocaleString("tr-TR")})
            </a>
          </>
        )}
      </div>

      {/* Sayfadakilerin hepsi seçiliyse: filtreye uyan tümünü seçme önerisi */}
      {pageAllSelected && total > rows.length && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-amber-900">
          {allMatching ? (
            <>
              Filtreye uyan <b>{total.toLocaleString("tr-TR")}</b> mağazanın tümü seçili.{" "}
              <button onClick={clearSelection} className="underline">
                Seçimi temizle
              </button>
            </>
          ) : (
            <>
              Bu sayfadaki {rows.length} mağaza seçili.{" "}
              <button onClick={() => setAllMatching(true)} className="font-medium underline">
                Filtreye uyan {total.toLocaleString("tr-TR")} mağazanın tümünü seç
              </button>
            </>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="px-6 py-14 text-center text-stone-500">Bu filtrelere uyan mağaza yok.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead className="bg-stone-50 text-xs text-stone-500">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:font-medium [&>th]:whitespace-nowrap">
                <th className="w-8">
                  <input type="checkbox" aria-label="Sayfadakilerin tümünü seç" checked={pageAllSelected} onChange={togglePage} />
                </th>
                <SortTh label="Mağaza" k="brand" filters={filters} href={href} />
                <th>Platform</th>
                <th>Durum</th>
                <th>Mail</th>
                {showShopifyColumns && <th>Eksik</th>}
                <SortTh label="Ülke" k="country" filters={filters} href={href} />
                <th>Dil</th>
                {showShopifyColumns && (
                  <>
                    <th>Kategori</th>
                    <SortTh label="Ürün" k="products" filters={filters} href={href} align="right" />
                    <SortTh label="Fiyat aralığı" k="price" filters={filters} href={href} />
                    <SortTh label="Son ürün" k="lastProduct" filters={filters} href={href} />
                  </>
                )}
                <SortTh label="TR" k="tr" filters={filters} href={href} align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isSel = allMatching || selected.has(r.id);
                return (
                  <tr
                    key={r.id}
                    className={`border-t border-stone-100 align-top [&>td]:px-3 [&>td]:py-2 ${isSel ? "bg-amber-50/60" : "hover:bg-stone-50"}`}
                  >
                    <td>
                      <input type="checkbox" aria-label={`${r.domain} seç`} checked={isSel} onChange={() => toggle(r.id)} />
                    </td>
                    <td className="min-w-56">
                      <BrandCell row={r} detailHref={href({}, { detail: String(r.id) })} />
                    </td>
                    <td>
                      <PlatformBadge row={r} />
                    </td>
                    <td>
                      <span
                        title={r.error ?? undefined}
                        className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_LABEL[r.status].cls}`}
                      >
                        {STATUS_LABEL[r.status].label}
                      </span>
                      {r.error && <div className="mt-0.5 max-w-40 truncate text-xs text-stone-400">{r.error}</div>}
                    </td>
                    <td className="max-w-64">
                      {r.primaryEmail ? (
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-[13px]" title={r.primaryEmail}>
                            {r.primaryEmail}
                          </span>
                          {r.primaryMx === false && (
                            <span className="rounded bg-red-100 px-1 text-[10px] text-red-700" title="Bu alan adında MX kaydı yok, mail ulaşmaz">
                              MX yok
                            </span>
                          )}
                          {r.emailCount > 1 && <span className="text-xs text-stone-400">+{r.emailCount - 1}</span>}
                        </div>
                      ) : (
                        <span className="text-stone-400">{r.status === "done" ? "bulunamadı" : "—"}</span>
                      )}
                    </td>
                    {showShopifyColumns && (
                      <td className="max-w-56">
                        {r.findings === null ? (
                          <span className="text-stone-300" title="Bu mağaza eksik kontrollerinden önce analiz edildi">
                            —
                          </span>
                        ) : r.findings.length ? (
                          <span
                            className="inline-block max-w-full truncate rounded bg-amber-100 px-1.5 py-0.5 align-middle text-xs font-medium text-amber-800"
                            title={r.findings.map((f) => f.label).join("\n")}
                          >
                            {r.findings[0].label}
                            {r.findings.length > 1 && ` +${r.findings.length - 1}`}
                          </span>
                        ) : (
                          <span className="text-stone-400">yok</span>
                        )}
                      </td>
                    )}
                    <td className="whitespace-nowrap">{countryLabel(r.country)}</td>
                    <td className="uppercase">{r.language ?? "—"}</td>
                    {showShopifyColumns && (
                      <>
                        <td className="max-w-44 truncate" title={r.category ?? undefined}>
                          {r.category ?? "—"}
                        </td>
                        <td className="text-right tabular-nums">{fmtInt(r.productCount)}</td>
                        <td className="whitespace-nowrap tabular-nums">{priceRange(r.priceMin, r.priceMax, r.currency)}</td>
                        <td className="whitespace-nowrap">{timeAgo(r.lastProductAt, now)}</td>
                      </>
                    )}
                    <td className="text-right">
                      <TrScore value={r.trScore} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sayfalama */}
      <div className="flex flex-wrap items-center gap-3 border-t border-stone-200 px-4 py-2 text-stone-600">
        <span>
          {total === 0
            ? "0 sonuç"
            : `${((filters.page - 1) * filters.pageSize + 1).toLocaleString("tr-TR")}–${Math.min(filters.page * filters.pageSize, total).toLocaleString("tr-TR")} / ${total.toLocaleString("tr-TR")}`}
        </span>
        <label className="flex items-center gap-1.5">
          Sayfa başına
          <select
            value={filters.pageSize}
            onChange={(e) => router.push(href({ pageSize: Number(e.target.value), page: 1 }), { scroll: false })}
            className="rounded border border-stone-300 px-1 py-0.5"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-1">
          <PageLink disabled={filters.page <= 1} href={href({ page: filters.page - 1 })}>
            ← Önceki
          </PageLink>
          <span className="px-2 tabular-nums">
            {filters.page} / {totalPages}
          </span>
          <PageLink disabled={filters.page >= totalPages} href={href({ page: filters.page + 1 })}>
            Sonraki →
          </PageLink>
        </div>
      </div>
    </section>
  );
}

function SortTh({
  label,
  k,
  filters,
  href,
  align,
}: {
  label: string;
  k: SortKey;
  filters: StoreFilters;
  href: (patch: Partial<StoreFilters>) => string;
  align?: "right";
}) {
  const active = filters.sort === k;
  const nextDir = active && filters.dir === "desc" ? "asc" : "desc";
  return (
    <th className={align === "right" ? "text-right" : undefined} aria-sort={active ? (filters.dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link href={href({ sort: k, dir: nextDir, page: 1 })} scroll={false} className={`hover:text-stone-900 ${active ? "text-stone-900" : ""}`}>
        {label}
        <span className="ml-0.5 inline-block w-2">{active ? (filters.dir === "desc" ? "↓" : "↑") : ""}</span>
      </Link>
    </th>
  );
}

function PageLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  if (disabled) return <span className="rounded px-2 py-1 text-stone-300">{children}</span>;
  return (
    <Link href={href} scroll={false} className="rounded px-2 py-1 hover:bg-stone-100">
      {children}
    </Link>
  );
}

function BrandCell({ row, detailHref }: { row: StoreRow; detailHref: string }) {
  const [editing, setEditing] = useState(false);
  const [, startTransition] = useTransition();
  const name = row.brandNameOverride ?? row.brandName;

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const value = String(new FormData(e.currentTarget).get("name") ?? "");
          startTransition(() => renameBrandAction(row.id, value));
          setEditing(false);
        }}
        className="flex gap-1"
      >
        <input
          name="name"
          defaultValue={name ?? ""}
          autoFocus
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          className="w-full rounded border border-stone-300 px-1.5 py-0.5"
          placeholder="Marka adı (boş = otomatik)"
        />
        <button className="rounded bg-stone-900 px-2 text-xs text-white">Kaydet</button>
      </form>
    );
  }

  return (
    <div>
      <div className="group flex items-center gap-1.5">
        <Link href={detailHref} scroll={false} className="font-medium hover:underline">
          {name ?? <span className="text-stone-400">{row.domain}</span>}
        </Link>
        {row.brandNameOverride && (
          <span className="text-[10px] text-stone-400" title={`Otomatik: ${row.brandName ?? "—"}`}>
            (düzenlendi)
          </span>
        )}
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-stone-400 opacity-0 group-hover:opacity-100 hover:text-stone-800 focus:opacity-100"
          title="Marka adını düzenle (mailde bu ad kullanılır)"
        >
          düzenle
        </button>
      </div>
      <a href={row.finalUrl ?? `https://${row.domain}`} target="_blank" rel="noreferrer" className="text-xs text-stone-500 hover:underline">
        {row.domain} ↗
      </a>
    </div>
  );
}

/** Tespit edilen platform rozeti. Henüz bilinmiyorsa (analiz bekliyor) "—". Düşük güvenli tespitler "?" ile işaretlenir. */
export function PlatformBadge({ row }: { row: Pick<StoreRow, "platform" | "status" | "source" | "platformEvidence"> }) {
  const platform = effectivePlatform(row);
  if (!platform) return <span className="text-stone-300">—</span>;

  const evidence = row.platformEvidence;
  const isLowConfidence = evidence?.confidence === "low";
  const title = evidence?.signals.length
    ? `${isLowConfidence ? "Düşük güven. " : ""}Dayanak: ${evidence.signals.join(", ")}`
    : platform === "unknown"
      ? "Ana sayfada bilinen bir platform izi bulunamadı"
      : undefined;
  const cls =
    platform === "shopify"
      ? "bg-emerald-100 text-emerald-800"
      : platform === "unknown"
        ? "bg-stone-100 text-stone-500"
        : "bg-sky-100 text-sky-800";

  return (
    <span title={title} className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}>
      {platform === "unknown" ? "Bilinmiyor" : PLATFORM_LABEL[platform]}
      {isLowConfidence && platform !== "unknown" && "?"}
    </span>
  );
}

export function TrScore({ value }: { value: number }) {
  const cls =
    value >= 60 ? "bg-red-600 text-white" : value >= 40 ? "bg-red-100 text-red-800" : value > 0 ? "bg-stone-100 text-stone-600" : "text-stone-300";
  return <span className={`inline-block min-w-8 rounded px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums ${cls}`}>{value}</span>;
}
