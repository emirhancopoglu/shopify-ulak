import { connection } from "next/server";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ui } from "@/components/ui";
import type { DiscoverySource } from "@/db/schema";
import { listIndexes, nextPageFor, type CrawlIndex } from "@/lib/discovery/commoncrawl";
import { DEFAULT_KEYWORDS, VARIATIONS } from "@/lib/discovery/ddg";
import { listRuns } from "@/lib/discovery/runs";
import { isWorkerAlive } from "@/lib/jobs";
import { latestGraph } from "@/lib/discovery/domainlist";
import { latestTrancoId } from "@/lib/discovery/tranco";
import { cachedWaybackPageCount, waybackNextPage } from "@/lib/discovery/wayback";
import { CcDomainsForm, CommonCrawlForm, DnsForm, RunCard, SearchForm, TrancoForm, WaybackForm } from "./discover-client";

export default function DiscoverPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className={ui.h1}>Keşif</h1>
        <p className={ui.sub}>
          Shopify mağazalarını otomatik bulur. Her aday hızlıca kontrol edilir (Shopify mı, Türk mü?), uygunsa asıl alan adıyla Mağazalar
          listesine eklenir ve analiz edilir. Listede olanlar atlanır.
        </p>
      </div>
      <Suspense fallback={<div className={`${ui.card} h-96 animate-pulse`} />}>
        <DiscoverContent />
      </Suspense>
    </div>
  );
}

async function DiscoverContent() {
  await connection();
  const runs = listRuns();
  const activeRuns = runs.filter((r) => r.status === "queued" || r.status === "running");
  const active = activeRuns.length > 0;
  const busy = (source: DiscoverySource) => activeRuns.some((r) => r.source === source);
  const workerAlive = isWorkerAlive();

  let indexes: CrawlIndex[] = [];
  try {
    indexes = (await listIndexes()).slice(0, 12);
  } catch {
    /* Common Crawl erişilemezse form elle giriş ister */
  }
  let graph: string | null = null;
  try {
    graph = await latestGraph();
  } catch {
    /* başlatınca tekrar denenir */
  }
  const scannedRun = graph ? runs.find((r) => r.source === "ccdomains" && r.status === "done" && r.params.graph === graph) : undefined;
  const scannedAt = scannedRun?.finishedAt ? scannedRun.finishedAt.toLocaleDateString("tr-TR") : null;

  let trancoId: string | null = null;
  try {
    trancoId = await latestTrancoId();
  } catch {
    /* başlatınca tekrar denenir */
  }
  const trancoNext = Math.max(
    0,
    ...runs.filter((r) => r.source === "tranco" && r.params.listId === trancoId).map((r) => Number(r.params.start ?? 0) + r.stats.cursor),
  );
  const waybackPages = cachedWaybackPageCount();

  const ccDefaults = indexes.length ? { index: indexes[0].id, startPage: nextPageFor(indexes[0].id) } : { index: "", startPage: 0 };
  const nextPages = Object.fromEntries(indexes.map((i) => [i.id, nextPageFor(i.id)]));

  return (
    <>
      {!workerAlive && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">
          Worker çalışmıyor; keşif başlamaz. Uygulamayı <code className="font-mono">npm run dev</code> ile başlatın.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <SearchForm defaultKeywords={DEFAULT_KEYWORDS.join("\n")} variations={VARIATIONS} disabled={busy("search")} />
        <CommonCrawlForm indexes={indexes} defaults={ccDefaults} nextPages={nextPages} disabled={busy("commoncrawl")} />
        <DnsForm disabled={busy("dns")} />
        <CcDomainsForm graph={graph} scannedAt={scannedAt} disabled={busy("ccdomains")} />
        <TrancoForm listId={trancoId} nextStart={trancoNext} disabled={busy("tranco")} />
        <WaybackForm nextPage={waybackNextPage()} totalPages={waybackPages} disabled={busy("wayback")} />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className={ui.h2}>Çalıştırmalar</h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-stone-500">Henüz keşif çalıştırılmadı.</p>
        ) : (
          runs.map((r) => <RunCard key={r.id} run={r} />)
        )}
      </section>
      <AutoRefresh active={active} intervalMs={3000} />
    </>
  );
}
