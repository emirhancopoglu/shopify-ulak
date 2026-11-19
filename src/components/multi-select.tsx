"use client";

import { useEffect, useRef, useState } from "react";

export type Option = { value: string; label: string; count?: number };

/** Açılır çoklu seçim menüsü (filtre çubuğu için). */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  emptyText = "Seçenek yok",
}: {
  label: string;
  options: Option[];
  value: string[];
  onChange: (next: string[]) => void;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = new Set(value);
  const filtered = search
    ? options.filter((o) => `${o.label} ${o.value}`.toLocaleLowerCase("tr").includes(search.toLocaleLowerCase("tr")))
    : options;

  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange([...next]);
  };

  const summary =
    value.length === 0
      ? null
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? value[0])
        : `${value.length} seçili`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 whitespace-nowrap ${
          value.length ? "border-stone-800 bg-stone-900 text-white" : "border-stone-300 bg-white hover:bg-stone-50"
        }`}
      >
        <span className={value.length ? "text-stone-300" : "text-stone-500"}>{label}</span>
        {summary && <span className="max-w-32 truncate font-medium">{summary}</span>}
        <span aria-hidden className="text-[10px] opacity-60">
          ▼
        </span>
      </button>

      {open && (
        <div className="absolute top-9 left-0 z-30 w-64 rounded-lg border border-stone-200 bg-white p-1.5 shadow-lg">
          {options.length > 8 && (
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Ara…"
              className="mb-1 w-full rounded border border-stone-200 px-2 py-1 outline-none focus:border-stone-400"
            />
          )}
          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 && <div className="px-2 py-3 text-center text-stone-400">{emptyText}</div>}
            {filtered.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-stone-50">
                <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} />
                <span className="flex-1 truncate">{o.label}</span>
                {o.count !== undefined && <span className="text-xs text-stone-400 tabular-nums">{o.count}</span>}
              </label>
            ))}
          </div>
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-stone-500 hover:bg-stone-50"
            >
              Seçimi temizle
            </button>
          )}
        </div>
      )}
    </div>
  );
}
