"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { Contact, Store } from "@/db/schema";
import { countryLabel, fmtInt, languageLabel, priceRange, STATUS_LABEL, timeAgo } from "@/lib/format";
import { addContactAction, deleteContactAction, reanalyzeAction, setPrimaryContactAction } from "./actions";
import { TrScore } from "./stores-table";

const SOCIAL_LABEL: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X / Twitter",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  whatsapp: "WhatsApp",
};

export function StoreDrawer({
  store,
  contacts,
  closeHref,
  now,
}: {
  store: Store;
  contacts: Contact[];
  closeHref: string;
  now: number;
}) {
  const router = useRouter();
  const close = () => router.push(closeHref, { scroll: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) router.push(closeHref, { scroll: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeHref, router]);

  const name = store.brandNameOverride ?? store.brandName ?? store.domain;
  const [isPending, startTransition] = useTransition();
  const busy = store.status === "pending" || store.status === "analyzing";

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={`${name} detayları`}>
      <Link href={closeHref} scroll={false} aria-label="Kapat" className="absolute inset-0 bg-stone-900/20" />
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-stone-200 bg-white px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{name}</h2>
              <TrScore value={store.trScore} />
            </div>
            <a href={store.finalUrl ?? `https://${store.domain}`} target="_blank" rel="noreferrer" className="text-stone-500 hover:underline">
              {store.domain} ↗
            </a>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded px-1.5 py-0.5 font-medium ${STATUS_LABEL[store.status].cls}`}>{STATUS_LABEL[store.status].label}</span>
              {store.error && <span className="text-red-700">{store.error}</span>}
              <span className="text-stone-400">
                {store.analyzedAt ? `Analiz: ${timeAgo(store.analyzedAt, now)}` : "Henüz analiz edilmedi"}
              </span>
            </div>
          </div>
          <button
            disabled={isPending || busy}
            onClick={() => startTransition(async () => void (await reanalyzeAction({ ids: [store.id] })))}
            className="rounded-md border border-stone-300 px-2.5 py-1 text-[13px] hover:bg-stone-50 disabled:opacity-40"
          >
            {busy ? "Analiz ediliyor…" : "Yeniden analiz"}
          </button>
          <button onClick={close} className="rounded-md px-2 py-1 text-stone-500 hover:bg-stone-100" aria-label="Kapat">
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-6 px-5 py-5">
          <ContactsSection storeId={store.id} contacts={contacts} />

          <Section title="Mağaza bilgileri">
            <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5">
              <Row k="Ülke" v={countryLabel(store.country)} />
              <Row k="Şehir / bölge" v={[store.city, store.province].filter(Boolean).join(", ") || "—"} />
              <Row k="Dil" v={store.language ? `${languageLabel(store.language)} (${store.language})` : "—"} />
              <Row k="Para birimi" v={store.currency ?? "—"} />
              <Row k="Kategori" v={store.category ?? "—"} />
              <Row k="Ürün sayısı" v={fmtInt(store.productCount)} />
              <Row k="Fiyat aralığı" v={priceRange(store.priceMin, store.priceMax, store.currency)} />
              <Row k="Son ürün" v={timeAgo(store.lastProductAt, now)} />
              <Row k="Tema" v={store.themeName ?? "—"} />
              <Row k="myshopify" v={store.myshopifyDomain ?? "—"} mono />
              <Row k="Kaynak" v={store.source} />
            </dl>
          </Section>

          {store.description && (
            <Section title="Açıklama">
              <p className="leading-relaxed text-stone-700">{store.description}</p>
            </Section>
          )}

          <Section title="Uygulamalar">
            {store.apps?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {store.apps.map((a) => (
                  <span key={a} className="rounded-full bg-stone-100 px-2.5 py-0.5 text-[13px] text-stone-700">
                    {a}
                  </span>
                ))}
              </div>
            ) : (
              <Empty>Tespit edilen uygulama yok.</Empty>
            )}
          </Section>

          <Section title="Sosyal medya">
            {store.socials && Object.keys(store.socials).length ? (
              <ul className="flex flex-col gap-1">
                {Object.entries(store.socials).map(([k, url]) => (
                  <li key={k} className="flex gap-3">
                    <span className="w-24 shrink-0 text-stone-500">{SOCIAL_LABEL[k] ?? k}</span>
                    <a href={url} target="_blank" rel="noreferrer" className="truncate text-stone-800 hover:underline">
                      {url.replace(/^https?:\/\/(www\.)?/, "")}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Sosyal medya linki bulunamadı.</Empty>
            )}
          </Section>
        </div>
      </aside>
    </div>
  );
}

function ContactsSection({ storeId, contacts }: { storeId: number; contacts: Contact[] }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <Section title={`Mail adresleri (${contacts.length})`} hint="Kampanyada birincil adrese gönderilir.">
      {contacts.length === 0 ? (
        <Empty>Sitede mail adresi bulunamadı. Aşağıdan elle ekleyebilirsiniz.</Empty>
      ) : (
        <ul className="divide-y divide-stone-100 rounded-md border border-stone-200">
          {contacts.map((c) => (
            <li key={c.id} className={`flex items-center gap-2 px-3 py-2 ${c.isPrimary ? "bg-emerald-50/60" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[13px]">{c.email}</span>
                  {c.isPrimary && <span className="rounded bg-emerald-600 px-1.5 text-[10px] font-medium text-white">BİRİNCİL</span>}
                  {c.mxValid === false && <span className="rounded bg-red-100 px-1 text-[10px] text-red-700">MX yok</span>}
                  {c.mxValid === null && <span className="rounded bg-stone-100 px-1 text-[10px] text-stone-500">MX ?</span>}
                </div>
                <div className="truncate text-xs text-stone-400">
                  {c.isManual ? (
                    "Elle eklendi"
                  ) : c.sourceUrl ? (
                    <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="hover:underline">
                      {c.sourceUrl.replace(/^https?:\/\/(www\.)?/, "")}
                    </a>
                  ) : null}
                </div>
              </div>
              {!c.isPrimary && (
                <button
                  disabled={isPending}
                  onClick={() => startTransition(() => setPrimaryContactAction(c.id))}
                  className="rounded px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-100"
                >
                  Birincil yap
                </button>
              )}
              <button
                disabled={isPending}
                onClick={() => confirm(`${c.email} silinsin mi?`) && startTransition(() => deleteContactAction(c.id))}
                className="rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
              >
                Sil
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const fd = new FormData(form);
          startTransition(async () => {
            const r = await addContactAction(storeId, String(fd.get("email") ?? ""), fd.get("primary") === "on");
            setMessage({ ok: r.ok, text: r.message });
            if (r.ok) form.reset();
          });
        }}
      >
        <input
          name="email"
          type="email"
          required
          placeholder="ornek@magaza.com"
          className="h-8 min-w-0 flex-1 rounded-md border border-stone-300 px-2.5 font-mono text-[13px] outline-none focus:border-stone-500"
        />
        <label className="flex items-center gap-1.5 text-[13px] text-stone-600">
          <input type="checkbox" name="primary" /> birincil yap
        </label>
        <button disabled={isPending} className="h-8 rounded-md bg-stone-900 px-3 text-white hover:bg-stone-700 disabled:opacity-40">
          Ekle
        </button>
        {message && <p className={`w-full text-[13px] ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p>}
      </form>
    </Section>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">{title}</h3>
        {hint && <span className="text-xs text-stone-400">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-stone-500">{k}</dt>
      <dd className={`min-w-0 truncate ${mono ? "font-mono text-[13px]" : ""}`} title={v}>
        {v}
      </dd>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-stone-400">{children}</p>;
}
