"use client";

import { useActionState, useRef, useState } from "react";
import { addStoresAction, type AddState } from "./actions";

export function AddStoresForm({ collapsed = false }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  const [text, setText] = useState("");
  const [state, formAction, pending] = useActionState<AddState, FormData>(async (prev, fd) => {
    const result = await addStoresAction(prev, fd);
    if (result?.ok) setText("");
    return result;
  }, null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText((t) => (t ? `${t}\n${content}` : content));
    e.target.value = "";
  }

  const lineCount = text.split(/[\s,;]+/).filter(Boolean).length;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group rounded-lg border border-stone-200 bg-white"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 select-none">
        <span className="font-medium">
          <span className="mr-1.5 inline-block text-stone-400 transition-transform group-open:rotate-90">▸</span>
          Mağaza ekle
        </span>
        <span className="text-xs text-stone-500">Alan adı, URL, CSV ya da serbest metin; adresler otomatik ayıklanır.</span>
      </summary>
    <form action={formAction} className="px-4 pb-4">
      <textarea
        id="domains"
        aria-label="Eklenecek alan adları"
        name="domains"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={"ornekmagaza.com.tr\nhttps://www.baskamagaza.com/collections/all\nmagaza.myshopify.com"}
        className="w-full resize-y rounded-md border border-stone-300 bg-stone-50 px-3 py-2 font-mono text-[13px] outline-none focus:border-stone-500 focus:bg-white"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || !text.trim()}
          className="rounded-md bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Ekleniyor…" : "Ekle ve analiz et"}
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-md border border-stone-300 px-3 py-2 hover:bg-stone-50"
        >
          CSV / TXT yükle
        </button>
        <input ref={fileRef} type="file" accept=".csv,.txt,text/plain,text/csv" onChange={onFile} hidden />
        {text.trim() && <span className="text-xs text-stone-500">~{lineCount} öğe</span>}
        {state && (
          <span className={state.ok ? "text-emerald-700" : "text-red-700"} role="status">
            {state.message}
          </span>
        )}
      </div>
    </form>
    </details>
  );
}
