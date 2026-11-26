import { connection } from "next/server";
import { Suspense } from "react";
import { nowMs } from "@/lib/format";
import { isWorkerAlive } from "@/lib/jobs";
import { parseFilters, serializeFilters } from "@/lib/store-filters";
import { getStoreDetail, queryStores, storeFacets, storeStats } from "@/lib/stores";
import { AddStoresForm } from "./add-stores-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { FiltersBar } from "./filters-bar";
import { StoreDrawer } from "./store-drawer";
import { StoresTable } from "./stores-table";

// Sayfa iskeleti (başlık) anında gelir; veritabanına bağlı kısım Suspense içinde akar.
export default function StoresPage({ searchParams }: PageProps<"/stores">) {
  return (
    <div className="mx-auto flex max-w-375 flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Mağazalar</h1>
        <p className="text-stone-500">
          Alan adı ekleyin; worker her birinin platformunu (Shopify, Next.js, WordPress…) tespit edip mail adresini arar. Üstteki Tür seçiciyle Shopify mağazalarını ve genel siteleri ayırabilirsiniz.
        </p>
      </div>
      <Suspense fallback={<LoadingSkeleton />}>
        <StoresContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function StoresContent({ searchParams }: { searchParams: PageProps<"/stores">["searchParams"] }) {
  await connection(); // SQLite senkron okunur ve Date.now() kullanılır; bu kısım her istekte çalışmalı
  const params = await searchParams;

  let filters = parseFilters(params);
  let { rows, total } = queryStores(filters);
  // Filtre değişip sayfa aralık dışında kaldıysa son sayfayı göster
  const lastPage = Math.max(1, Math.ceil(total / filters.pageSize));
  if (filters.page > lastPage) {
    filters = { ...filters, page: lastPage };
    ({ rows, total } = queryStores(filters));
  }

  const stats = storeStats();
  const facets = storeFacets();
  const workerAlive = isWorkerAlive();
  const now = nowMs();

  const detailId = Number(Array.isArray(params.detail) ? params.detail[0] : params.detail);
  const detail = Number.isInteger(detailId) && detailId > 0 ? getStoreDetail(detailId) : null;
  const detailBusy = detail?.store.status === "pending" || detail?.store.status === "analyzing";

  return (
    <>
      <div className="flex flex-wrap items-stretch gap-3">
        <section className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-6">
          <Stat label="Toplam" value={stats.total} />
          <Stat label="Analiz bekleyen" value={stats.pending} />
          <Stat label="Shopify" value={stats.shopify} hint="Analizi biten Shopify mağazaları" />
          <Stat label="Genel site" value={stats.general} hint="Analizi biten, Shopify dışındaki siteler" />
          <Stat label="Mail bulunan" value={stats.withEmail} />
          <Stat label="Türkiye odaklı" value={stats.turkish} hint="TR puanı ≥ 40" />
        </section>
        <WorkerBadge alive={workerAlive} pending={stats.pending} />
      </div>

      <AddStoresForm collapsed={stats.total > 0} />
      <FiltersBar filters={filters} facets={facets} total={total} />
      <StoresTable key={serializeFilters({ ...filters, page: 1 }).toString()} rows={rows} total={total} filters={filters} now={now} />

      {detail && (
        <StoreDrawer
          key={detail.store.id}
          store={detail.store}
          contacts={detail.contacts}
          closeHref={`/stores?${serializeFilters(filters)}`}
          now={now}
        />
      )}
      <AutoRefresh active={stats.pending > 0 || detailBusy} />
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-4 py-3" title={hint}>
      <div className="text-xs text-stone-500">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums">{value.toLocaleString("tr-TR")}</div>
    </div>
  );
}

function WorkerBadge({ alive, pending }: { alive: boolean; pending: number }) {
  if (!alive) {
    return (
      <div className="flex max-w-xs items-center rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">
        <span>
          <span className="font-medium">Worker çalışmıyor.</span> Analiz için uygulamayı <code className="font-mono">npm run dev</code> ile başlatın.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-4 py-3 text-stone-700">
      <span className={`size-2 rounded-full ${pending ? "animate-pulse bg-amber-500" : "bg-emerald-500"}`} />
      {pending ? `Worker çalışıyor · ${pending} sırada` : "Worker hazır"}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-5" aria-busy="true" aria-label="Yükleniyor">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-17 rounded-lg border border-stone-200 bg-white" />
        ))}
      </div>
      <div className="h-12 rounded-lg border border-stone-200 bg-white" />
      <div className="h-24 rounded-lg border border-stone-200 bg-white" />
      <div className="h-96 rounded-lg border border-stone-200 bg-white" />
    </div>
  );
}
