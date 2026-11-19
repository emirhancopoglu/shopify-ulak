import type { CampaignCounts } from "@/lib/campaigns";

export function ProgressBar({ counts, className = "" }: { counts: CampaignCounts; className?: string }) {
  const total = Math.max(1, counts.total);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className={className}>
      <div className="flex h-2 overflow-hidden rounded-full bg-stone-100">
        <div className="bg-emerald-600" style={{ width: pct(counts.sent) }} />
        <div className="bg-red-500" style={{ width: pct(counts.failed) }} />
        <div className="bg-stone-300" style={{ width: pct(counts.skipped) }} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500 tabular-nums">
        <span>
          <b className="text-emerald-700">{counts.sent}</b> gönderildi
        </span>
        <span>
          <b className="text-stone-800">{counts.queued + counts.sending}</b> sırada
        </span>
        {counts.failed > 0 && (
          <span>
            <b className="text-red-700">{counts.failed}</b> başarısız
          </span>
        )}
        {counts.skipped > 0 && <span>{counts.skipped} atlandı</span>}
        <span className="ml-auto">toplam {counts.total}</span>
      </div>
    </div>
  );
}
