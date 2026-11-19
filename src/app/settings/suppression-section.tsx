"use client";

import { useActionState, useTransition } from "react";
import { ui, type FormState } from "@/components/ui";
import { SUPPRESSION_LABEL } from "@/lib/suppression-labels";
import { addSuppressionAction, removeSuppressionAction } from "./actions";

type Item = { email: string; reason: string; note: string | null; createdAt: Date };

export function SuppressionSection({ items }: { items: Item[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addSuppressionAction, null);
  const [removing, startRemove] = useTransition();

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className={ui.h2}>Kara liste ({items.length})</h2>
        <p className={ui.sub}>
          Bu adreslere hiçbir kampanyada mail gönderilmez. &quot;Çıkar&quot; diye yanıt verenleri buraya ekleyin. Geri dönen
          (reddedilen) adresler otomatik eklenir.
        </p>
      </div>

      <form action={action} className={`${ui.card} flex flex-wrap items-start gap-2 p-4`}>
        <textarea name="emails" rows={1} required placeholder="ornek@magaza.com (birden fazla için virgül/satır)" className={`${ui.textarea} min-w-64 flex-1 font-mono text-[13px]`} />
        <input name="note" placeholder="Not (isteğe bağlı)" className={`${ui.input} w-48`} />
        <button disabled={pending} className={ui.btnPrimary}>
          Ekle
        </button>
        {state && <p className={`w-full text-[13px] ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</p>}
      </form>

      {items.length > 0 && (
        <div className={`${ui.card} max-h-96 overflow-y-auto`}>
          <table className="w-full text-left">
            <tbody>
              {items.map((s) => (
                <tr key={s.email} className="border-b border-stone-100 last:border-0 [&>td]:px-4 [&>td]:py-2">
                  <td className="font-mono text-[13px]">{s.email}</td>
                  <td className="text-stone-500">{SUPPRESSION_LABEL[s.reason] ?? s.reason}</td>
                  <td className="max-w-56 truncate text-xs text-stone-400" title={s.note ?? undefined}>
                    {s.note}
                  </td>
                  <td className="text-right">
                    <button
                      disabled={removing}
                      onClick={() => startRemove(() => removeSuppressionAction(s.email))}
                      className="text-xs text-stone-500 hover:text-red-700"
                    >
                      Kaldır
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
