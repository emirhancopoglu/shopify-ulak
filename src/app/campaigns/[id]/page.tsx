import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ui } from "@/components/ui";
import { RECIPIENT_STATUSES, type RecipientStatus } from "@/db/schema";
import { getAccount, listAccounts, sentInLast24h } from "@/lib/accounts";
import { CAMPAIGN_STATUS, RECIPIENT_STATUS } from "@/lib/campaign-labels";
import { audienceMismatchReport, getCampaign, listRecipients, missingVarsReport, previewRecipient, RECIPIENT_PAGE_SIZE } from "@/lib/campaigns";
import { nowMs } from "@/lib/format";
import { isWorkerAlive } from "@/lib/jobs";
import { AUDIENCE_LABEL } from "@/lib/template-audience";
import { listTemplates } from "@/lib/template-store";
import { ProgressBar } from "../progress-bar";
import { AudienceMismatchBox, CampaignControls, NextSend, RecipientsTable, SettingsForm } from "./campaign-client";

type Props = PageProps<"/campaigns/[id]">;

export default function CampaignPage({ params, searchParams }: Props) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <Link href="/campaigns" className="text-stone-500 hover:text-stone-900">
        ← Kampanyalar
      </Link>
      <Suspense fallback={<div className={`${ui.card} h-[60vh] animate-pulse`} />}>
        <CampaignContent params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function CampaignContent({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  const sp = await searchParams;
  const campaign = getCampaign(Number(id));
  if (!campaign) notFound();

  const statusFilter = (RECIPIENT_STATUSES as readonly string[]).includes(one(sp.status) ?? "") ? (one(sp.status) as RecipientStatus) : undefined;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const recipients = listRecipients(campaign.id, { status: statusFilter, page });
  const preview = previewRecipient(campaign.id, Number(one(sp.preview)) || undefined);
  const templates = listTemplates().map((t) => ({ id: t.id, name: t.name, format: t.format, audience: t.audience }));
  const mismatch = campaign.status === "draft" || campaign.status === "paused" ? audienceMismatchReport(campaign.id) : null;
  const accounts = listAccounts();
  const account = campaign.accountId ? getAccount(campaign.accountId) : undefined;
  const sent24h = account ? sentInLast24h(account.id) : 0;
  const missing = campaign.status === "draft" || campaign.status === "paused" ? missingVarsReport(campaign.id) : { count: 0, vars: [] };
  const workerAlive = isWorkerAlive();
  const now = nowMs();

  const editable = campaign.status === "draft" || campaign.status === "paused";
  const remaining = campaign.counts.queued + campaign.counts.sending;
  const hoursLeft = remaining / campaign.perHour;
  const daysByLimit = account ? Math.ceil(remaining / account.dailyLimit) : 1;

  const created = one(sp.created);
  const skippedNotes = [
    ["noEmail", "mail adresi yok"],
    ["noMx", "alan adı mail almıyor (MX yok)"],
    ["suppressed", "kara listede"],
    ["contacted", "daha önce mail atılmış"],
    ["duplicate", "aynı adres tekrar ediyor"],
  ]
    .filter(([k]) => Number(one(sp[k])) > 0)
    .map(([k, label]) => `${one(sp[k])} ${label}`);

  const baseHref = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { status: statusFilter, page: page > 1 ? String(page) : undefined, preview: one(sp.preview), ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    return `/campaigns/${campaign.id}${q.size ? `?${q}` : ""}`;
  };

  return (
    <>
      {/* Başlık + kontroller */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className={`${ui.h1} truncate`}>{campaign.name}</h1>
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${CAMPAIGN_STATUS[campaign.status].cls}`}>{CAMPAIGN_STATUS[campaign.status].label}</span>
          </div>
          {campaign.statusReason && campaign.status !== "running" && <p className="mt-1 text-amber-800">{campaign.statusReason}</p>}
        </div>
        <CampaignControls id={campaign.id} status={campaign.status} hasFailed={campaign.counts.failed > 0} />
      </div>

      {created !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900">
          Kampanya taslağı oluşturuldu: <b>{created}</b> alıcı eklendi.
          {skippedNotes.length > 0 && <> Elenenler: {skippedNotes.join(", ")}.</>} Şablon ve gönderen hesabı seçip başlatabilirsiniz.
        </div>
      )}

      {!workerAlive && campaign.status === "running" && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">
          Worker çalışmıyor; gönderim yapılamaz. Uygulamayı <code className="font-mono">npm run dev</code> ile başlatın.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex flex-col gap-4">
          {/* İlerleme */}
          <section className={`${ui.card} p-4`}>
            <ProgressBar counts={campaign.counts} />
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-stone-500">Hız</dt>
              <dd>
                saatte {campaign.perHour} (ortalama {Math.round(3600 / campaign.perHour)} sn arayla)
              </dd>
              <dt className="text-stone-500">Kalan süre</dt>
              <dd>
                {remaining === 0
                  ? "—"
                  : `~${hoursLeft < 1 ? `${Math.ceil(hoursLeft * 60)} dk` : `${hoursLeft.toFixed(1).replace(".", ",")} saat`}${daysByLimit > 1 ? ` · günlük limit nedeniyle en az ${daysByLimit} gün` : ""}`}
              </dd>
              {campaign.status === "running" && (
                <>
                  <dt className="text-stone-500">Sıradaki mail</dt>
                  <dd>
                    <NextSend at={campaign.nextSendAt?.getTime() ?? null} />
                  </dd>
                </>
              )}
              {account && (
                <>
                  <dt className="text-stone-500">Hesap (24 saat)</dt>
                  <dd>
                    {sent24h} / {account.dailyLimit} gönderim
                  </dd>
                </>
              )}
            </dl>
          </section>

          {/* Ayarlar */}
          <SettingsForm
            key={`${campaign.templateId}-${campaign.accountId}-${campaign.perHour}-${campaign.name}`}
            campaign={{ id: campaign.id, name: campaign.name, templateId: campaign.templateId, accountId: campaign.accountId, perHour: campaign.perHour }}
            templates={templates}
            accounts={accounts.map((a) => ({ id: a.id, label: `${a.fromName} <${a.email}>`, dailyLimit: a.dailyLimit }))}
            editable={editable}
          />

          {mismatch && editable && (
            <AudienceMismatchBox campaignId={campaign.id} templateName={mismatch.templateName} audienceLabel={AUDIENCE_LABEL[mismatch.audience]} count={mismatch.count} />
          )}

          {missing.count > 0 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
              ⚠ {missing.count} alıcıda boş kalacak değişken var: {missing.vars.map((v) => `{{${v}}}`).join(", ")}. Şablonda yedek değer verin (örn.{" "}
              <code className="font-mono">{`{{${missing.vars[0]}|...}}`}</code>).
            </p>
          )}
        </div>

        {/* Önizleme */}
        <section className={`${ui.card} overflow-hidden`}>
          <div className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2 text-[13px]">
            <span className="font-medium">Önizleme</span>
            {preview && <span className="truncate text-stone-500">→ {preview.recipient.email}</span>}
            {campaign.status !== "draft" && <span className="ml-auto text-xs text-stone-400">başlatıldığı andaki şablon</span>}
          </div>
          {preview ? (
            <>
              <div className="border-b border-stone-100 px-4 py-2 font-semibold">{preview.email.subject}</div>
              {preview.email.html ? (
                <iframe title="Önizleme" sandbox="" srcDoc={preview.email.html} className="h-105 w-full" />
              ) : (
                <pre className="max-h-105 overflow-y-auto px-4 py-3 font-sans text-[14px] leading-relaxed whitespace-pre-wrap">{preview.email.text}</pre>
              )}
            </>
          ) : (
            <p className="px-4 py-10 text-center text-stone-400">Önizleme için bir şablon seçin.</p>
          )}
        </section>
      </div>

      {/* Alıcılar */}
      <section className={ui.card}>
        <div className="flex flex-wrap items-center gap-1 border-b border-stone-200 px-3 py-2">
          <Tab href={baseHref({ status: undefined, page: undefined })} active={!statusFilter}>
            Tümü ({campaign.counts.total})
          </Tab>
          {RECIPIENT_STATUSES.filter((s) => s !== "sending").map((s) => (
            <Tab key={s} href={baseHref({ status: s, page: undefined })} active={statusFilter === s}>
              {RECIPIENT_STATUS[s].label} ({campaign.counts[s]})
            </Tab>
          ))}
        </div>
        <RecipientsTable
          rows={recipients.rows.map((r) => ({ id: r.id, email: r.email, marka: r.vars.marka ?? "", site: r.vars.site ?? "", status: r.status, error: r.error, sentAt: r.sentAt?.getTime() ?? null }))}
          previewHrefPattern={baseHref({ preview: "__ID__" })}
          previewId={preview?.recipient.id ?? null}
          now={now}
        />
        {recipients.total > RECIPIENT_PAGE_SIZE && (
          <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-4 py-2 text-[13px]">
            {page > 1 && <Link href={baseHref({ page: String(page - 1) })}>← Önceki</Link>}
            <span className="text-stone-500">
              {page} / {Math.ceil(recipients.total / RECIPIENT_PAGE_SIZE)}
            </span>
            {page * RECIPIENT_PAGE_SIZE < recipients.total && <Link href={baseHref({ page: String(page + 1) })}>Sonraki →</Link>}
          </div>
        )}
      </section>

      <AutoRefresh active={campaign.status === "running"} intervalMs={5000} />
    </>
  );
}

function Tab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} scroll={false} className={`rounded-md px-2.5 py-1 text-[13px] ${active ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}>
      {children}
    </Link>
  );
}
