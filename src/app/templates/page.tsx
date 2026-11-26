import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ui } from "@/components/ui";
import { nowMs, timeAgo } from "@/lib/format";
import { AUDIENCE_SHORT_LABEL } from "@/lib/template-audience";
import { listTemplates } from "@/lib/template-store";
import { createTemplateAction } from "./actions";

export default function TemplatesPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className={ui.h1}>Şablonlar</h1>
          <p className={ui.sub}>Kampanyalarda kullanılacak mail metinleri. Varsayılan biçim düz metin.</p>
        </div>
        <form action={createTemplateAction}>
          <button className={ui.btnPrimary}>+ Yeni şablon</button>
        </form>
      </div>
      <Suspense fallback={<div className={`${ui.card} h-40 animate-pulse`} />}>
        <TemplateList />
      </Suspense>
    </div>
  );
}

async function TemplateList() {
  await connection();
  const templates = listTemplates();
  const now = nowMs();
  return (
    <div className="flex flex-col gap-3">
      {templates.map((t) => (
        <Link key={t.id} href={`/templates/${t.id}`} className={`${ui.card} block p-4 hover:border-stone-400`}>
          <div className="flex items-center gap-2">
            <span className="font-medium">{t.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${t.format === "html" ? "bg-violet-100 text-violet-800" : "bg-stone-100 text-stone-600"}`}>
              {t.format === "html" ? "HTML" : "DÜZ METİN"}
            </span>
            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-semibold text-sky-800">{AUDIENCE_SHORT_LABEL[t.audience]}</span>
            <span className="ml-auto text-xs text-stone-400">güncellendi {timeAgo(t.updatedAt, now)}</span>
          </div>
          <div className="mt-1 truncate text-stone-600">
            <span className="text-stone-400">Konu:</span> {t.subject}
          </div>
          <div className="mt-1 line-clamp-2 text-[13px] text-stone-400">{t.bodyText.slice(0, 240)}</div>
        </Link>
      ))}
    </div>
  );
}
