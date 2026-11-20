"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { ui, type FormState } from "@/components/ui";
import type { DiscoveryRun, DiscoveryStatus } from "@/db/schema";
import { cancelRunAction, deleteRunAction, resumeRunAction, startCommonCrawlAction, startDnsAction, startSearchAction } from "./actions";

const SOURCE_LABEL: Record<DiscoveryRun["source"], string> = { search: "Arama (DuckDuckGo)", commoncrawl: "Common Crawl", dns: "DNS listesi" };

const STATUS: Record<DiscoveryStatus, { label: string; cls: string }> = {
  queued: { label: "Sırada", cls: "bg-stone-100 text-stone-700" },
  running: { label: "Çalışıyor", cls: "bg-emerald-600 text-white animate-pulse" },
  done: { label: "Bitti", cls: "bg-stone-800 text-white" },
  failed: { label: "Başarısız", cls: "bg-red-100 text-red-800" },
  cancelled: { label: "İptal edildi", cls: "bg-stone-200 text-stone-600" },
  blocked: { label: "Engellendi", cls: "bg-amber-100 text-amber-900" },
};

function Card({ title, desc, children }: { title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`${ui.card} flex flex-col gap-3 p-4`}>
      <div>
        <h2 className={ui.h2}>{title}</h2>
        <p className="mt-0.5 text-[13px] text-stone-500">{desc}</p>
      </div>
      {children}
    </div>
  );
}

function TrOnly({ defaultChecked }: { defaultChecked: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-[13px]">
      <input type="checkbox" name="trOnly" defaultChecked={defaultChecked} /> Yalnızca Türk mağazaları (ülke TR ya da para birimi TRY)
    </label>
  );
}

function Submit({ pending, disabled, children }: { pending: boolean; disabled: boolean; children: React.ReactNode }) {
  return (
    <button disabled={pending || disabled} className={ui.btnPrimary} title={disabled ? "Çalışan bir keşif var" : undefined}>
      {pending ? "Başlatılıyor…" : children}
    </button>
  );
}

const Msg = ({ state }: { state: FormState }) =>
  state ? <p className={`text-[13px] ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</p> : null;

// ---------------------------------------------------------------------------

export function SearchForm({
  defaultKeywords,
  variations,
  disabled,
}: {
  defaultKeywords: string;
  variations: { value: string; label: string }[];
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(startSearchAction, null);
  const [keywords, setKeywords] = useState(defaultKeywords);
  const [selected, setSelected] = useState<Set<string>>(new Set(["", "türkiye"]));
  const kwCount = keywords.split(/\r?\n|,/).filter((k) => k.trim()).length;
  const queries = kwCount * Math.max(1, selected.size);
  const minutes = Math.ceil((queries * 14) / 60);

  return (
    <Card
      title="Arama"
      desc={
        <>
          DuckDuckGo&apos;da <code>site:myshopify.com &lt;kelime&gt;</code> araması. Türk mağazaları için en verimli kaynak; sorgu başına ~10 sonuç.
        </>
      }
    >
      <form action={action} className="flex flex-col gap-3">
        <label className="block">
          <span className={ui.label}>Kategori kelimeleri (her satıra bir tane)</span>
          <textarea name="keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={8} className={`${ui.textarea} text-[13px]`} />
        </label>
        <div>
          <span className={ui.label}>Varyasyonlar (her biri farklı 10 sonuç getirir)</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {variations.map((v) => (
              <label key={v.value || "plain"} className="flex items-center gap-1 text-[13px]">
                <input
                  type="checkbox"
                  name="variations"
                  value={v.value}
                  checked={selected.has(v.value)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(v.value);
                      else n.delete(v.value);
                      return n;
                    })
                  }
                />
                {v.label}
              </label>
            ))}
          </div>
        </div>
        <TrOnly defaultChecked />
        <p className="text-xs text-stone-500">
          {queries} sorgu · tahmini ~{minutes} dk. Engellenmemek için sorgular 10-16 sn arayla gider; DuckDuckGo yavaşlatırsa bekleyip devam eder.
        </p>
        <Submit pending={pending} disabled={disabled}>
          Aramayı başlat
        </Submit>
        <Msg state={state} />
      </form>
    </Card>
  );
}

export function CommonCrawlForm({
  indexes,
  defaults,
  nextPages,
  disabled,
}: {
  indexes: { id: string; name: string }[];
  defaults: { index: string; startPage: number };
  nextPages: Record<string, number>;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(startCommonCrawlAction, null);
  const [index, setIndex] = useState(defaults.index);
  const [startPage, setStartPage] = useState(defaults.startPage);

  return (
    <Card
      title="Common Crawl"
      desc="Ücretsiz web arşivindeki *.myshopify.com adresleri. Çok büyük ama global: Türk oranı %1'in altında. Sunucusu sık yoğun (504) olur."
    >
      <form action={action} className="flex flex-col gap-3">
        <label className="block">
          <span className={ui.label}>Dizin (tarama dönemi)</span>
          {indexes.length ? (
            <select
              name="index"
              value={index}
              onChange={(e) => {
                setIndex(e.target.value);
                setStartPage(nextPages[e.target.value] ?? 0);
              }}
              className={ui.input}
            >
              {indexes.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          ) : (
            <input name="index" placeholder="CC-MAIN-2026-43" className={ui.input} />
          )}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={ui.label}>Başlangıç sayfası</span>
            <input name="startPage" type="number" min={0} value={startPage} onChange={(e) => setStartPage(Number(e.target.value))} className={ui.input} />
          </label>
          <label className="block">
            <span className={ui.label}>Sayfa sayısı</span>
            <input name="pageCount" type="number" min={1} max={200} defaultValue={5} className={ui.input} />
          </label>
        </div>
        <TrOnly defaultChecked />
        <p className="text-xs text-stone-500">
          Sayfa başına ~100 mağaza kontrol edilir. Başlangıç sayfası, bu dizinde en son kalınan yere otomatik ayarlanır.
        </p>
        <Submit pending={pending} disabled={disabled}>
          Taramayı başlat
        </Submit>
        <Msg state={state} />
      </form>
    </Card>
  );
}

export function DnsForm({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(startDnsAction, null);
  return (
    <Card
      title="Alan adı listesi"
      desc="Elinizdeki bir listeyi (rehber, dizin, rakip listesi…) sayfa açmadan DNS ile süzer; yalnızca Shopify'a bağlı olanlar eklenir."
    >
      <form action={action} className="flex flex-col gap-3">
        <label className="block">
          <span className={ui.label}>Alan adları (yapıştırın; serbest metin olabilir)</span>
          <textarea name="domains" rows={8} placeholder={"ornekmagaza.com.tr\nbaskamagaza.com\n…"} className={`${ui.textarea} font-mono text-[12px]`} />
        </label>
        <TrOnly defaultChecked={false} />
        <p className="text-xs text-stone-500">Saniyede onlarca alan adı kontrol edilir; en fazla 20.000.</p>
        <Submit pending={pending} disabled={disabled}>
          Listeyi kontrol et
        </Submit>
        <Msg state={state} />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function RunCard({ run }: { run: DiscoveryRun }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<FormState>(null);
  const s = run.stats;
  const pct = s.total ? Math.round((s.cursor / s.total) * 100) : 0;
  const active = run.status === "queued" || run.status === "running";
  const resumable = ["blocked", "failed", "cancelled"].includes(run.status) && s.cursor < s.total;
  const p = run.params as { keywords?: string[]; index?: string; startPage?: number; pageCount?: number; domains?: string[]; trOnly?: boolean };

  const summary =
    run.source === "search"
      ? `${(p.keywords ?? []).slice(0, 4).join(", ")}${(p.keywords?.length ?? 0) > 4 ? ` +${(p.keywords?.length ?? 0) - 4}` : ""}`
      : run.source === "commoncrawl"
        ? `${p.index} · sayfa ${p.startPage}–${(p.startPage ?? 0) + (p.pageCount ?? 0) - 1}`
        : `${p.domains?.length ?? 0} alan adı`;

  return (
    <div className={`${ui.card} p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{SOURCE_LABEL[run.source]}</span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATUS[run.status].cls}`}>{STATUS[run.status].label}</span>
        <span className="truncate text-[13px] text-stone-500">
          {summary}
          {p.trOnly !== false ? " · yalnızca TR" : ""}
        </span>
        <div className="ml-auto flex gap-2">
          {active && (
            <button disabled={pending} onClick={() => start(() => cancelRunAction(run.id))} className={`${ui.btn} h-8`}>
              İptal
            </button>
          )}
          {resumable && (
            <button disabled={pending} onClick={() => start(async () => setMsg(await resumeRunAction(run.id)))} className={`${ui.btn} h-8`}>
              Devam ettir
            </button>
          )}
          {!active && (
            <button disabled={pending} onClick={() => start(() => deleteRunAction(run.id))} className="h-8 px-2 text-[13px] text-stone-400 hover:text-red-700">
              Sil
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-100">
        <div className="h-full bg-stone-800 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-stone-600 tabular-nums">
        <span>
          {s.cursor}/{s.total} {run.source === "search" ? "sorgu" : run.source === "commoncrawl" ? "sayfa" : "alan adı"}
        </span>
        <span>{s.candidates} aday</span>
        <span>{s.shopify} Shopify</span>
        {p.trOnly !== false && <span>{s.matched} Türk</span>}
        <span>{s.known} zaten listede</span>
        <Link href={`/stores?source=${run.source}&sort=created`} className="font-medium text-emerald-700 hover:underline">
          +{s.added} eklendi →
        </Link>
      </div>

      {run.error && <p className="mt-2 text-[13px] text-amber-800">{run.error}</p>}
      {msg && !msg.ok && <p className="mt-2 text-[13px] text-red-700">{msg.message}</p>}

      {run.log.length > 0 && (
        <details className="mt-2" open={active}>
          <summary className="cursor-pointer text-xs text-stone-500">Kayıt ({run.log.length})</summary>
          <pre className="mt-1 max-h-48 overflow-y-auto rounded bg-stone-50 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-stone-600">
            {[...run.log].reverse().join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
