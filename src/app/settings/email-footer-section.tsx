"use client";

import { useActionState, useMemo, useState } from "react";
import { ui, type FormState } from "@/components/ui";
import { wrapFooterHtml } from "@/lib/template";
import { saveEmailFooterAction } from "./actions";

const SAMPLE_BODY = "Merhaba Örnek Butik ekibi,<br><br>Bu, mail metninizin göründüğü yerdir. Altında alt bilginiz yer alır.<br><br>İyi çalışmalar.";
const FREE_HOSTING = /\b[a-z0-9-]+\.(vercel\.app|netlify\.app|github\.io|herokuapp\.com|web\.app|pages\.dev|onrender\.com|wixsite\.com|blogspot\.com|webflow\.io)\b/i;

/** Alt bilgi HTML'i için teslim edilebilirlik ipuçları (kesin spam testi değildir). */
function footerHints(html: string): { level: "warn" | "bad"; text: string }[] {
  const out: { level: "warn" | "bad"; text: string }[] = [];
  if (!html.trim()) return out;
  const images = (html.match(/<img\s/gi) ?? []).length;
  const links = (html.match(/<a\s/gi) ?? []).length;
  if (images > 0) {
    out.push({
      level: "warn",
      text: `${images} görsel var. Gönderim sırasında mail içine otomatik gömülür (CID); Gelen Kutusu'nda tıklamadan görünür, ancak soğuk mailde görsel spam puanını artırabilir ve Gereksiz E-posta'da yine gizlenebilir.`,
    });
  }
  if (links > 3) out.push({ level: "warn", text: `${links} link var; soğuk mailde toplam 1-3 link önerilir (mail metnindekilerle birlikte).` });
  if (FREE_HOSTING.test(html)) out.push({ level: "bad", text: "Ücretsiz hosting adresi (vercel.app vb.) var; spam filtreleri bu linklere sert davranır." });
  if (/shopify/i.test(html)) out.push({ level: "warn", text: "Alt bilgide \"Shopify\" geçiyor; bu alt bilgi tüm maillere gider (Next.js, WordPress siteleri dahil)." });
  if (!/çıkar|unsubscribe|rahatsız etmem|istemiyorsanız/i.test(html)) out.push({ level: "warn", text: "Alt bilgide abonelikten çıkma satırı yok; şablon metninde olması yeterli ama burada da bulunması iyi olur." });
  return out;
}

export function EmailFooterSection({ footerHtml }: { footerHtml: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveEmailFooterAction, null);
  const [value, setValue] = useState(footerHtml);
  const dirty = value.trim() !== footerHtml.trim();
  const hints = useMemo(() => footerHints(value), [value]);
  const preview = useMemo(
    () =>
      `<!doctype html><html><body style="margin:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1c1c1f;">${SAMPLE_BODY}${value.trim() ? wrapFooterHtml(value) : ""}</body></html>`,
    [value],
  );

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className={ui.h2}>Mail alt bilgisi (HTML)</h2>
        <p className={ui.sub}>
          Buraya yapıştırdığınız HTML, <b>tüm maillerin en altına</b> eklenir (kampanya, test gönderimi ve önizleme). Kutu boşsa hiçbir şey eklenmez. Düz metin
          şablonlarda mail, metnin birebir HTML karşılığı ve alt bilgiyle birlikte gider; düz metin alternatifi de alt bilgiden otomatik üretilir.
        </p>
      </div>
      <form action={action} className={`${ui.card} flex flex-col gap-3 p-4`}>
        <label className="block">
          <span className={ui.label}>Alt bilgi HTML&apos;i</span>
          <textarea
            name="footerHtml"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={12}
            spellCheck={false}
            placeholder={'<tr>\n  <td style="padding-top:22px;">…</td>\n</tr>'}
            className={`${ui.textarea} font-mono text-[12px] leading-relaxed`}
          />
          <span className={ui.hint}>
            <code>&lt;tr&gt;…&lt;/tr&gt;</code> satırı olarak yazarsanız otomatik bir tabloya sarılır; başka HTML olduğu gibi eklenir. script, iframe ve form etiketlerine izin
            verilmez. HTTPS görseller (PNG/JPG/GIF/WebP, en fazla 512 KB) gönderimde mail içine otomatik olarak gömülür (CID).
          </span>
        </label>

        {hints.length > 0 && (
          <ul className="flex flex-col gap-1 text-[13px]">
            {hints.map((h) => (
              <li key={h.text} className={h.level === "bad" ? "text-red-700" : "text-amber-700"}>
                {h.level === "bad" ? "✕" : "⚠"} {h.text}
              </li>
            ))}
          </ul>
        )}

        <div>
          <span className={ui.label}>Önizleme</span>
          <iframe title="Alt bilgi önizleme" sandbox="" srcDoc={preview} className="h-72 w-full rounded-md border border-stone-200 bg-white" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className={ui.btnPrimary} disabled={pending || !dirty}>
            {pending ? "Kaydediliyor…" : dirty ? "Kaydet" : "Kaydedildi"}
          </button>
          {value.trim() && (
            <button type="button" className={ui.btn} disabled={pending} onClick={() => setValue("")}>
              Temizle
            </button>
          )}
          {dirty && <span className="text-xs text-amber-700">Kaydedilmemiş değişiklik var{!value.trim() ? " (kaydedince alt bilgi kaldırılır)" : ""}</span>}
          {state && <span className={`text-[13px] ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</span>}
        </div>
      </form>
    </section>
  );
}
