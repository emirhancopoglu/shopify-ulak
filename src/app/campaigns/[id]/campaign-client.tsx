"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";
import { ui, type FormState } from "@/components/ui";
import type { CampaignStatus, RecipientStatus, TemplateAudience, TemplateFormat } from "@/db/schema";
import { RECIPIENT_STATUS } from "@/lib/campaign-labels";
import { AUDIENCE_SHORT_LABEL } from "@/lib/template-audience";
import {
  deleteCampaignAction,
  pauseCampaignAction,
  removeAudienceMismatchesAction,
  removeRecipientAction,
  retryFailedAction,
  saveCampaignSettingsAction,
  startCampaignAction,
  stopCampaignAction,
  updateRecipientBrandAction,
} from "../actions";

// ---------------------------------------------------------------------------
// Başlat / duraklat / durdur
// ---------------------------------------------------------------------------

export function CampaignControls({ id, status, hasFailed }: { id: number; status: CampaignStatus; hasFailed: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<FormState>(null);

  const run = (fn: () => Promise<FormState | void | number>) =>
    start(async () => {
      const r = await fn();
      setMsg(r && typeof r === "object" ? r : null);
    });

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap gap-2">
        {(status === "draft" || status === "paused") && (
          <button disabled={pending} onClick={() => run(() => startCampaignAction(id))} className={`${ui.btnPrimary} bg-emerald-700 hover:bg-emerald-600`}>
            ▶ {status === "draft" ? "Gönderimi başlat" : "Devam ettir"}
          </button>
        )}
        {status === "running" && (
          <button disabled={pending} onClick={() => run(() => pauseCampaignAction(id))} className={ui.btn}>
            ❚❚ Duraklat
          </button>
        )}
        {hasFailed && status !== "running" && (
          <button disabled={pending} onClick={() => run(() => retryFailedAction(id))} className={ui.btn}>
            Başarısızları yeniden dene
          </button>
        )}
        {(status === "running" || status === "paused") && (
          <button
            disabled={pending}
            onClick={() => confirm("Kampanya kalıcı olarak durdurulsun mu? Sıradaki mailler gönderilmez.") && run(() => stopCampaignAction(id))}
            className={ui.btnDanger}
          >
            ■ Durdur
          </button>
        )}
        {status !== "running" && (
          <button
            disabled={pending}
            onClick={() => confirm("Kampanya ve gönderim kayıtları silinsin mi? Silinen kampanyadaki adresler 'daha önce mail atıldı' kontrolünden de düşer.") && run(() => deleteCampaignAction(id))}
            className={ui.btnDanger}
          >
            Sil
          </button>
        )}
      </div>
      {msg && !msg.ok && <span className="text-[13px] text-red-700">{msg.message}</span>}
      {status === "draft" && <span className="text-xs text-stone-500">Başlatınca worker mailleri saatlik hıza göre rastgele aralıklarla gönderir.</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hedef kitle uyarısı (şablon ile alıcılar uyuşmuyor)
// ---------------------------------------------------------------------------

export function AudienceMismatchBox({
  campaignId,
  templateName,
  audienceLabel,
  count,
}: {
  campaignId: number;
  templateName: string;
  audienceLabel: string;
  count: number;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<FormState>(null);
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-900">
      <p>
        ✕ &quot;{templateName}&quot; şablonu yalnızca <b>{audienceLabel}</b> için hazırlanmış, ama kuyrukta buna uymayan <b>{count}</b> alıcı var. Bu hâlde kampanya başlatılamaz.
        Şablonu değiştirin ya da uymayan alıcıları çıkarın.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={pending}
          onClick={() => confirm(`${count} alıcı kampanyadan çıkarılsın mı?`) && start(async () => setMsg(await removeAudienceMismatchesAction(campaignId)))}
          className={ui.btnDanger}
        >
          {pending ? "Çıkarılıyor…" : "Uymayanları çıkar"}
        </button>
        {msg && !msg.ok && <span className="text-red-700">{msg.message}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ayarlar
// ---------------------------------------------------------------------------

export function SettingsForm({
  campaign,
  templates,
  accounts,
  editable,
}: {
  campaign: { id: number; name: string; templateId: number | null; accountId: number | null; perHour: number };
  templates: { id: number; name: string; format: TemplateFormat; audience: TemplateAudience }[];
  accounts: { id: number; label: string; dailyLimit: number }[];
  editable: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveCampaignSettingsAction, null);
  const [perHour, setPerHour] = useState(campaign.perHour);

  return (
    <form action={action} className={`${ui.card} flex flex-col gap-3 p-4`}>
      <input type="hidden" name="id" value={campaign.id} />
      <div className="flex items-center justify-between">
        <h2 className={ui.h2}>Ayarlar</h2>
        {!editable && <span className="text-xs text-stone-500">Değiştirmek için duraklatın</span>}
      </div>
      <fieldset disabled={!editable || pending} className="flex flex-col gap-3">
        <label className="block">
          <span className={ui.label}>Kampanya adı</span>
          <input name="name" defaultValue={campaign.name} className={ui.input} />
        </label>
        <label className="block">
          <span className={ui.label}>Şablon</span>
          <select name="templateId" defaultValue={campaign.templateId ?? ""} className={ui.input}>
            <option value="">— seçin —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} {t.format === "html" ? "(HTML) " : ""}· {AUDIENCE_SHORT_LABEL[t.audience]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={ui.label}>Gönderen hesap</span>
          <select name="accountId" defaultValue={campaign.accountId ?? ""} className={ui.input}>
            <option value="">— seçin —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          {accounts.length === 0 && (
            <span className={ui.hint}>
              Hesap yok. <Link href="/settings" className="underline">Ayarlar</Link>&apos;dan bir gönderen hesap bağlayın.
            </span>
          )}
        </label>
        <label className="block">
          <span className={ui.label}>Saatte kaç mail</span>
          <div className="flex items-center gap-3">
            <input name="perHour" type="number" min={1} max={200} value={perHour} onChange={(e) => setPerHour(Number(e.target.value))} className={`${ui.input} w-24`} />
            <span className="text-[13px] text-stone-500">≈ her {perHour > 0 ? Math.round(3600 / perHour) : "—"} sn&apos;de bir (rastgele ±%50)</span>
          </div>
          {perHour > 30 && (
            <span className="mt-1 block text-xs text-amber-700">
              Yeni ya da ücretsiz hesapta saatte 30&apos;dan fazla soğuk mail, hesabın kısıtlanma riskini artırır. İlk hafta 10-20 ile başlayın.
            </span>
          )}
        </label>
      </fieldset>
      {editable && (
        <div className="flex items-center gap-3">
          <button disabled={pending} className={ui.btn}>
            {pending ? "Kaydediliyor…" : "Ayarları kaydet"}
          </button>
          {state && <span className={`text-[13px] ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</span>}
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sıradaki gönderim geri sayımı
// ---------------------------------------------------------------------------

export function NextSend({ at }: { at: number | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  if (at === null || now === null) return <span>—</span>;
  const s = Math.round((at - now) / 1000);
  if (s <= 0) return <span>şimdi gönderiliyor…</span>;
  const time = new Date(at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <span className="tabular-nums">
      {time} ({s >= 60 ? `${Math.floor(s / 60)} dk ${s % 60} sn` : `${s} sn`} sonra)
    </span>
  );
}

// ---------------------------------------------------------------------------
// Alıcı tablosu
// ---------------------------------------------------------------------------

type Row = { id: number; email: string; marka: string; site: string; status: RecipientStatus; error: string | null; sentAt: number | null };

export function RecipientsTable({ rows, previewHrefPattern, previewId, now }: { rows: Row[]; previewHrefPattern: string; previewId: number | null; now: number }) {
  if (rows.length === 0) return <p className="px-4 py-8 text-center text-stone-400">Bu durumda alıcı yok.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="bg-stone-50 text-xs text-stone-500">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
            <th>Marka ({"{{marka}}"})</th>
            <th>Mail</th>
            <th>Durum</th>
            <th>Zaman</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <RecipientRow key={r.id} row={r} previewHref={previewHrefPattern.replace("__ID__", String(r.id))} active={r.id === previewId} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecipientRow({ row, previewHref, active, now }: { row: Row; previewHref: string; active: boolean; now: number }) {
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const queued = row.status === "queued";

  return (
    <tr className={`border-t border-stone-100 align-top [&>td]:px-3 [&>td]:py-2 ${active ? "bg-amber-50/60" : ""}`}>
      <td className="min-w-48">
        {editing ? (
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const v = String(new FormData(e.currentTarget).get("marka") ?? "");
              start(async () => {
                const r = await updateRecipientBrandAction(row.id, v);
                if (r?.ok) setEditing(false);
                else setErr(r?.message ?? null);
              });
            }}
          >
            <input name="marka" defaultValue={row.marka} autoFocus onKeyDown={(e) => e.key === "Escape" && setEditing(false)} className="w-full rounded border border-stone-300 px-1.5 py-0.5" />
            <button disabled={pending} className="rounded bg-stone-900 px-2 text-xs text-white">
              Kaydet
            </button>
          </form>
        ) : (
          <div className="group flex items-center gap-1.5">
            <span className="font-medium">{row.marka}</span>
            {queued && (
              <button onClick={() => setEditing(true)} className="text-xs text-stone-400 opacity-0 group-hover:opacity-100 hover:text-stone-800 focus:opacity-100">
                düzenle
              </button>
            )}
          </div>
        )}
        <div className="text-xs text-stone-400">{row.site}</div>
        {err && <div className="text-xs text-red-700">{err}</div>}
      </td>
      <td className="font-mono text-[13px]">{row.email}</td>
      <td>
        <span className={`text-[13px] font-medium ${RECIPIENT_STATUS[row.status].cls}`}>{RECIPIENT_STATUS[row.status].label}</span>
        {row.error && <div className="max-w-72 text-xs text-stone-500">{row.error}</div>}
      </td>
      <td className="text-[13px] whitespace-nowrap text-stone-500">
        {row.sentAt
          ? new Date(row.sentAt).toLocaleString("tr-TR", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              ...(now - row.sentAt > 86_400_000 ? {} : { second: "2-digit" }),
            })
          : "—"}
      </td>
      <td className="text-right whitespace-nowrap">
        <Link href={previewHref} scroll={false} className="text-xs text-stone-500 hover:text-stone-900">
          önizle
        </Link>
        {queued && (
          <button disabled={pending} onClick={() => start(() => removeRecipientAction(row.id))} className="ml-3 text-xs text-stone-400 hover:text-red-700">
            çıkar
          </button>
        )}
      </td>
    </tr>
  );
}
