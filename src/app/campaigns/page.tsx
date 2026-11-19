import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ui } from "@/components/ui";
import { CAMPAIGN_STATUS } from "@/lib/campaign-labels";
import { listCampaigns } from "@/lib/campaigns";
import { nowMs, timeAgo } from "@/lib/format";
import { AutoRefresh } from "@/components/auto-refresh";
import { ProgressBar } from "./progress-bar";

export default function CampaignsPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className={ui.h1}>Kampanyalar</h1>
        <p className={ui.sub}>
          Yeni kampanya için <Link href="/stores" className="underline">Mağazalar</Link> sayfasında mağazaları seçip &quot;Kampanya oluştur&quot; deyin.
        </p>
      </div>
      <Suspense fallback={<div className={`${ui.card} h-40 animate-pulse`} />}>
        <CampaignList />
      </Suspense>
    </div>
  );
}

async function CampaignList() {
  await connection();
  const campaigns = listCampaigns();
  const now = nowMs();

  if (campaigns.length === 0) {
    return (
      <div className={`${ui.card} border-dashed px-6 py-12 text-center text-stone-500`}>
        Henüz kampanya yok. Mağazalar sayfasında filtreleyip seçtiğiniz mağazalardan bir kampanya oluşturabilirsiniz.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {campaigns.map((c) => (
        <Link key={c.id} href={`/campaigns/${c.id}`} className={`${ui.card} block p-4 hover:border-stone-400`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{c.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${CAMPAIGN_STATUS[c.status].cls}`}>{CAMPAIGN_STATUS[c.status].label}</span>
            <span className="ml-auto text-xs text-stone-400">oluşturuldu {timeAgo(c.createdAt, now)}</span>
          </div>
          <div className="mt-1 text-[13px] text-stone-500">
            {c.templateName ?? "şablon seçilmedi"} · {c.accountEmail ?? "hesap seçilmedi"} · saatte {c.perHour}
          </div>
          {c.statusReason && c.status === "paused" && <div className="mt-1 text-[13px] text-amber-800">{c.statusReason}</div>}
          <ProgressBar counts={c.counts} className="mt-3" />
        </Link>
      ))}
      <AutoRefresh active={campaigns.some((c) => c.status === "running")} intervalMs={5000} />
    </div>
  );
}
