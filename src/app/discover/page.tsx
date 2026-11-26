import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ui } from "@/components/ui";
import type { DiscoverySource } from "@/db/schema";
import { listIndexes, nextPageFor, type CrawlIndex } from "@/lib/discovery/commoncrawl";
import { DEFAULT_KEYWORDS, VARIATIONS } from "@/lib/discovery/ddg";
import { isGeneralSource } from "@/lib/discovery/source-groups";
import { listRuns } from "@/lib/discovery/runs";
import { isWorkerAlive } from "@/lib/jobs";
import { latestGraph } from "@/lib/discovery/domainlist";
import { latestTrancoId } from "@/lib/discovery/tranco";
import { cachedWaybackPageCount, waybackNextPage } from "@/lib/discovery/wayback";
import {
  CcDomainsForm,
  CommonCrawlForm,
  DnsForm,
  GeneralCcDomainsForm,
  RunCard,
  SearchForm,
  TrancoForm,
  WaybackForm,
} from "./discover-client";

type Tab = "shopify" | "genel";

const SUB: Record<Tab, string> = {
  shopify:
    "Shopify mağazalarını otomatik bulur. Her aday hızlıca kontrol edilir (Shopify mı, Türk mü?), uygunsa asıl alan adıyla Mağazalar listesine eklenir ve analiz edilir. Listede olanlar atlanır.",
  genel:
    "Shopify dışındaki siteleri bulur (Next.js, React, Angular, Vue, WordPress…). Her aday için DNS kaydı ve ana sayfa kontrol edilir; seçtiğiniz platformdaki siteler Mağazalar listesine eklenir. Shopify siteleri bu sekmede eklenmez.",
};

export default function DiscoverPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  // searchParams'a erişim Suspense içinde olmalı (cacheComponents prerender uyarısı)
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <Suspense fallback={<div className={`${ui.card} h-96 animate-pulse`} />}>
        <DiscoverShell searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function DiscoverShell({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const activeTab: Tab = tab === "genel" ? "genel" : "shopify";
  return (
    <>
      <div>
        <h1 className={ui.h1}>Keşif</h1>
        <p className={ui.sub}>{SUB[activeTab]}</p>
      </div>
      <nav className="flex gap-1 border-b border-stone-200">
        <TabLink href="/discover" active={activeTab === "shopify"}>
          Shopify Mağazaları
        </TabLink>
        <TabLink href="/discover?tab=genel" active={activeTab === "genel"}>
          Genel Siteler
        </TabLink>
      </nav>
      <Suspense fallback={<div className={`${ui.card} h-96 animate-pulse`} />}>
        <DiscoverContent tab={activeTab} />
      </Suspense>
    </>
  );
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`-mb-px border-b-2 px-3 py-2 text-[14px] ${active ? "border-stone-800 font-medium text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}
    >
      {children}
    </Link>
  );
}

async function DiscoverContent({ tab }: { tab: Tab }) {
  await connection();
  const allRuns = listRuns();
  const general = tab === "genel";
  const runs = allRuns.filter((r) => isGeneralSource(r.source) === general);
  const activeRuns = allRuns.filter((r) => r.status === "queued" || r.status === "running");
  const active = activeRuns.length > 0;
  const busy = (source: DiscoverySource) => activeRuns.some((r) => r.source === source);
  const workerAlive = isWorkerAlive();

  let graph: string | null = null;
  try {
    graph = await latestGraph();
  } catch {
    /* başlatınca tekrar denenir */
  }

  let trancoId: string | null = null;
  try {
    trancoId = await latestTrancoId();
  } catch {
    /* başlatınca tekrar denenir */
  }

  const trancoNext = Math.max(
    0,
    ...allRuns.filter((r) => r.source === "tranco" && r.params.listId === trancoId).map((r) => Number(r.params.start ?? 0) + r.stats.cursor),
  );
  const generalCcNext = Math.max(
    0,
    ...allRuns.filter((r) => r.source === "general_ccdomains" && r.params.graph === graph).map((r) => Number(r.params.start ?? 0) + r.stats.cursor),
  );

  return (
    <>
      {!workerAlive && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">
          Worker çalışmıyor; keşif başlamaz. Uygulamayı <code className="font-mono">npm run dev</code> ile başlatın.
        </div>
      )}

      {general ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <GeneralCcDomainsForm graph={graph} nextStart={generalCcNext} disabled={busy("general_ccdomains")} />
        </div>
      ) : (
        <ShopifyForms graph={graph} trancoId={trancoId} trancoNext={trancoNext} busy={busy} />
      )}

      <section className="flex flex-col gap-3">
        <h2 className={ui.h2}>Çalıştırmalar</h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-stone-500">
            {general ? "Bu sekmede henüz genel site taraması yapılmadı." : "Henüz keşif çalıştırılmadı."}
          </p>
        ) : (
          runs.map((r) => <RunCard key={r.id} run={r} />)
        )}
      </section>
      <AutoRefresh active={active} intervalMs={3000} />
    </>
  );
}

/** Shopify sekmesinin formları (Common Crawl dizinleri ve Wayback sayfaları ağdan okunur, yalnız bu sekmede). */
async function ShopifyForms({
  graph,
  trancoId,
  trancoNext,
  busy,
}: {
  graph: string | null;
  trancoId: string | null;
  trancoNext: number;
  busy: (source: DiscoverySource) => boolean;
}) {
  let indexes: CrawlIndex[] = [];
  try {
    indexes = (await listIndexes()).slice(0, 12);
  } catch {
    /* Common Crawl erişilemezse form elle giriş ister */
  }
  const scannedRunCompletedAt = scannedAtFor(graph);
  const waybackPages = cachedWaybackPageCount();
  const ccDefaults = indexes.length ? { index: indexes[0].id, startPage: nextPageFor(indexes[0].id) } : { index: "", startPage: 0 };
  const nextPages = Object.fromEntries(indexes.map((i) => [i.id, nextPageFor(i.id)]));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <SearchForm defaultKeywords={DEFAULT_KEYWORDS.join("\n")} variations={VARIATIONS} disabled={busy("search")} />
      <CommonCrawlForm indexes={indexes} defaults={ccDefaults} nextPages={nextPages} disabled={busy("commoncrawl")} />
      <DnsForm disabled={busy("dns")} />
      <CcDomainsForm graph={graph} scannedAt={scannedRunCompletedAt} disabled={busy("ccdomains")} />
      <TrancoForm listId={trancoId} nextStart={trancoNext} disabled={busy("tranco")} />
      <WaybackForm nextPage={waybackNextPage()} totalPages={waybackPages} disabled={busy("wayback")} />
    </div>
  );
}

/** Bu liste sürümünün Shopify taraması ne zaman bitti (varsa). */
function scannedAtFor(graph: string | null): string | null {
  if (!graph) return null;
  const done = listRuns().find((r) => r.source === "ccdomains" && r.status === "done" && r.params.graph === graph);
  return done?.finishedAt ? done.finishedAt.toLocaleDateString("tr-TR") : null;
}
