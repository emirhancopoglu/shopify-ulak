"use client";

import { useTransition } from "react";
import { ui } from "@/components/ui";
import { setListUnsubscribeAction } from "./actions";

export function SendingOptions({ listUnsubscribe }: { listUnsubscribe: boolean }) {
  const [pending, start] = useTransition();
  return (
    <section className="flex flex-col gap-3">
      <h2 className={ui.h2}>Gönderim seçenekleri</h2>
      <label className={`${ui.card} flex cursor-pointer items-start gap-3 p-4`}>
        <input
          type="checkbox"
          className="mt-1"
          checked={listUnsubscribe}
          disabled={pending}
          onChange={(e) => {
            const v = e.target.checked;
            start(() => setListUnsubscribeAction(v));
          }}
        />
        <span>
          <span className="font-medium">&quot;Abonelikten çık&quot; başlığı ekle</span> <code className="text-xs text-stone-500">List-Unsubscribe</code>
          <span className={`${ui.hint} block`}>
            Gmail/Outlook bu başlıkla maile bir &quot;abonelikten çık&quot; bağlantısı koyar. Google bunu yalnızca günde 5000+ mail gönderenlere
            zorunlu tutar; az sayıda kişisel görünmesi gereken mailde bülten sinyali verebilir. Kapatırsanız metindeki &quot;ilgilenmiyorsanız
            yazmanız yeterli&quot; türü satır yine de kalmalı.
          </span>
        </span>
      </label>
    </section>
  );
}
