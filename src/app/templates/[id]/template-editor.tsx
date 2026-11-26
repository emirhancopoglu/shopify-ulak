"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { ui, type FormState } from "@/components/ui";
import { TEMPLATE_AUDIENCES, type Platform, type Template, type TemplateAudience, type TemplateFormat } from "@/db/schema";
import { HTML_STARTER, renderEmail, VARIABLES } from "@/lib/template";
import { AUDIENCE_LABEL, audienceAccepts } from "@/lib/template-audience";
import { deleteTemplateAction, duplicateTemplateAction, saveTemplateAction, sendTestAction } from "../actions";

type AccountLite = { id: number; email: string; fromName: string; signature: string };
type Sample = { id: number; label: string; vars: Record<string, string>; kind: "shopify" | "general"; platform: Platform | null };

const EXAMPLE_VARS: Record<string, string> = Object.fromEntries(VARIABLES.map((v) => [v.key, v.example]));

export function TemplateEditor({ template, accounts, samples, footerHtml }: { template: Template; accounts: AccountLite[]; samples: Sample[]; footerHtml: string | null }) {
  const [name, setName] = useState(template.name);
  const [format, setFormat] = useState<TemplateFormat>(template.format);
  const [audience, setAudience] = useState<TemplateAudience>(template.audience);
  const [subject, setSubject] = useState(template.subject);
  const [bodyText, setBodyText] = useState(template.bodyText);
  const [bodyHtml, setBodyHtml] = useState(template.bodyHtml ?? "");
  const [saved, setSaved] = useState(() => JSON.stringify([template.name, template.format, template.audience, template.subject, template.bodyText, template.bodyHtml ?? ""]));
  const [saveState, setSaveState] = useState<FormState>(null);
  const [saving, startSave] = useTransition();

  const [sampleId, setSampleId] = useState<number | "example">(samples[0]?.id ?? "example");
  const [accountId, setAccountId] = useState<number | null>(accounts[0]?.id ?? null);

  // Değişken butonları en son odaklanılan alana ekler
  const subjectRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<"subject" | "text" | "html">("text");

  const current = JSON.stringify([name, format, audience, subject, bodyText, bodyHtml]);
  const dirty = current !== saved;
  const input = { name, format, audience, subject, bodyText, bodyHtml: format === "html" ? bodyHtml : bodyHtml || null };

  const account = accounts.find((a) => a.id === accountId);
  // Önizleme örnekleri şablonun hedef kitlesine göre süzülür
  const visibleSamples = useMemo(() => samples.filter((s) => audienceAccepts(audience, { kind: s.kind, platform: s.platform })), [samples, audience]);
  const sample = sampleId === "example" ? undefined : (visibleSamples.find((s) => s.id === sampleId) ?? visibleSamples[0]);
  const vars = useMemo(
    () => ({
      ...(sample?.vars ?? EXAMPLE_VARS),
      imza: account?.signature || EXAMPLE_VARS.imza,
      gonderen: account?.fromName || EXAMPLE_VARS.gonderen,
    }),
    [sample, account],
  );
  const rendered = useMemo(() => renderEmail({ format, subject, bodyText, bodyHtml }, vars, { footerHtml }), [format, subject, bodyText, bodyHtml, vars, footerHtml]);
  const hints = useMemo(
    () => contentHints(subject, rendered.text, format === "html" ? bodyHtml : null, audience, `${subject}\n${bodyText}\n${bodyHtml}`),
    [subject, rendered.text, format, bodyHtml, bodyText, audience],
  );

  const insert = (key: string) => {
    const token = `{{${key}}}`;
    const target = lastFocused.current;
    const el = target === "subject" ? subjectRef.current : target === "html" ? htmlRef.current : textRef.current;
    const setter = target === "subject" ? setSubject : target === "html" ? setBodyHtml : setBodyText;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setter(el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const switchFormat = (f: TemplateFormat) => {
    setFormat(f);
    if (f === "html" && !bodyHtml.trim()) setBodyHtml(HTML_STARTER);
    lastFocused.current = f === "html" ? "html" : "text";
  };

  const save = () =>
    startSave(async () => {
      const r = await saveTemplateAction(template.id, input);
      setSaveState(r);
      if (r?.ok) setSaved(current);
    });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* --- Sol: düzenleme --- */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Şablon adı" className={`${ui.input} max-w-sm text-base font-semibold`} />
          <div className="flex rounded-md border border-stone-300 p-0.5" role="radiogroup" aria-label="Biçim">
            {(["text", "html"] as const).map((f) => (
              <button
                key={f}
                role="radio"
                aria-checked={format === f}
                onClick={() => switchFormat(f)}
                className={`rounded px-3 py-1 text-[13px] ${format === f ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}
              >
                {f === "text" ? "Düz metin" : "HTML (tasarımlı)"}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-stone-500">Hedef kitle</span>
          <select value={audience} onChange={(e) => setAudience(e.target.value as TemplateAudience)} className={`${ui.input} h-8 max-w-xs`}>
            {TEMPLATE_AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABEL[a]}
              </option>
            ))}
          </select>
          <span className="text-xs text-stone-400">Kampanya, bu kitleye uymayan siteler varken başlatılamaz.</span>
        </label>

        {format === "html" && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
            Tasarımlı mailler Gmail&apos;de &quot;Promosyonlar&quot; sekmesine düşmeye daha yatkındır. Görsel ve çok sayıda link kullanmayın; önce kendinize test gönderin.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-stone-500">Değişken ekle:</span>
          {VARIABLES.map((v) => (
            <button
              key={v.key}
              type="button"
              title={`${v.label} · örn. ${v.example.split("\n")[0]}`}
              onMouseDown={(e) => e.preventDefault()} // odak alandan gitmesin
              onClick={() => insert(v.key)}
              className="rounded-full border border-stone-300 bg-white px-2 py-0.5 font-mono text-xs text-stone-700 hover:border-stone-500"
            >
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>

        <label className="block">
          <span className={ui.label}>Konu</span>
          <input
            ref={subjectRef}
            value={subject}
            onFocus={() => (lastFocused.current = "subject")}
            onChange={(e) => setSubject(e.target.value)}
            className={ui.input}
          />
        </label>

        {format === "text" ? (
          <label className="block">
            <span className={ui.label}>Mail metni</span>
            <textarea
              ref={textRef}
              value={bodyText}
              onFocus={() => (lastFocused.current = "text")}
              onChange={(e) => setBodyText(e.target.value)}
              rows={20}
              className={`${ui.textarea} font-mono text-[13px] leading-relaxed`}
            />
          </label>
        ) : (
          <>
            <label className="block">
              <span className={ui.label}>HTML gövde</span>
              <textarea
                ref={htmlRef}
                value={bodyHtml}
                onFocus={() => (lastFocused.current = "html")}
                onChange={(e) => setBodyHtml(e.target.value)}
                rows={16}
                spellCheck={false}
                className={`${ui.textarea} font-mono text-[12px] leading-relaxed`}
              />
            </label>
            <label className="block">
              <span className={ui.label}>Düz metin alternatifi</span>
              <textarea
                ref={textRef}
                value={bodyText}
                onFocus={() => (lastFocused.current = "text")}
                onChange={(e) => setBodyText(e.target.value)}
                rows={5}
                placeholder="Boş bırakılırsa HTML'den otomatik üretilir."
                className={`${ui.textarea} font-mono text-[12px]`}
              />
              <span className={ui.hint}>HTML göstermeyen mail istemcileri bunu görür; her mailde HTML ile birlikte gönderilir.</span>
            </label>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={save} disabled={saving || !dirty} className={ui.btnPrimary}>
            {saving ? "Kaydediliyor…" : dirty ? "Kaydet" : "Kaydedildi"}
          </button>
          {saveState && !saveState.ok && <span className="text-red-700">{saveState.message}</span>}
          {dirty && <span className="text-xs text-amber-700">Kaydedilmemiş değişiklik var</span>}
          <div className="ml-auto flex gap-2">
            <button onClick={() => duplicateTemplateAction(template.id)} className={ui.btn}>
              Kopyala
            </button>
            <button
              onClick={() => confirm(`"${template.name}" silinsin mi? Bu şablonu kullanan taslak kampanyalardan kaldırılır.`) && deleteTemplateAction(template.id)}
              className={ui.btnDanger}
            >
              Sil
            </button>
          </div>
        </div>
      </div>

      {/* --- Sağ: önizleme --- */}
      <div className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-xs whitespace-nowrap text-stone-500">Site</span>
            <select
              value={sample?.id ?? "example"}
              onChange={(e) => setSampleId(e.target.value === "example" ? "example" : Number(e.target.value))}
              className={`${ui.input} h-8 min-w-0`}
            >
              {visibleSamples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              <option value="example">Örnek veri</option>
            </select>
          </label>
          <label className="flex min-w-0 items-center gap-2">
            <span className="text-xs whitespace-nowrap text-stone-500">Gönderen</span>
            <select
              value={accountId ?? ""}
              onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}
              className={`${ui.input} h-8 min-w-0`}
            >
              {accounts.length === 0 && <option value="">Hesap yok (örnek imza)</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={`${ui.card} overflow-hidden`}>
          <div className="border-b border-stone-200 bg-stone-50 px-4 py-3 text-[13px]">
            <div className="text-stone-500">
              Kimden: <span className="text-stone-800">{account ? `${account.fromName} <${account.email}>` : "—"}</span>
            </div>
            <div className="text-stone-500">
              Kime: <span className="text-stone-800">{sample ? (sample.label.split(" · ")[1] ?? "") : "ornekbutik.com"}</span>
            </div>
            <div className="mt-1 text-[15px] font-semibold text-stone-900">{rendered.subject || <span className="text-stone-400">(konu yok)</span>}</div>
          </div>
          {rendered.html ? (
            <iframe title="HTML önizleme" sandbox="" srcDoc={rendered.html} className="h-[55vh] w-full bg-white" />
          ) : (
            <pre className="max-h-[55vh] overflow-y-auto px-4 py-4 font-sans text-[14px] leading-relaxed whitespace-pre-wrap text-stone-800">{rendered.text}</pre>
          )}
        </div>

        {(rendered.missing.length > 0 || hints.length > 0) && (
          <ul className="flex flex-col gap-1 text-[13px]">
            {rendered.missing.length > 0 && (
              <li className="text-red-700">
                ✕ Bu mağaza için boş kalan değişken: {rendered.missing.map((m) => `{{${m}}}`).join(", ")}. Yedek değer verin, örn.{" "}
                <code className="font-mono">{`{{${rendered.missing[0]}|...}}`}</code>
              </li>
            )}
            {hints.map((h) => (
              <li key={h.text} className={h.level === "bad" ? "text-red-700" : "text-amber-700"}>
                {h.level === "bad" ? "✕" : "⚠"} {h.text}
              </li>
            ))}
          </ul>
        )}

        <TestSend accounts={accounts} accountId={accountId} input={input} vars={vars} dirty={dirty} />
      </div>
    </div>
  );
}

function TestSend({
  accounts,
  accountId,
  input,
  vars,
  dirty,
}: {
  accounts: AccountLite[];
  accountId: number | null;
  input: Parameters<typeof sendTestAction>[0];
  vars: Record<string, string>;
  dirty: boolean;
}) {
  const account = accounts.find((a) => a.id === accountId);
  const [to, setTo] = useState("");
  const [prefix, setPrefix] = useState(true);
  const [state, setState] = useState<FormState>(null);
  const [pending, start] = useTransition();

  if (accounts.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-stone-300 px-4 py-3 text-[13px] text-stone-500">
        Test gönderimi için önce <a href="/settings" className="underline">Ayarlar</a>&apos;dan bir Gmail, Outlook ya da kurumsal mail hesabı bağlayın.
      </p>
    );
  }

  return (
    <div className={`${ui.card} flex flex-col gap-2 p-3`}>
      <div className="text-[13px] font-medium">Test gönderimi</div>
      <div className="flex gap-2">
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={account?.email ?? "alici@ornek.com"}
          className={`${ui.input} h-8 font-mono text-[13px]`}
        />
        <button
          disabled={pending || !accountId}
          onClick={() =>
            start(async () => {
              setState(await sendTestAction(input, accountId!, to.trim() || account!.email, vars, prefix));
            })
          }
          className={`${ui.btn} h-8`}
        >
          {pending ? "Gönderiliyor…" : "Test gönder"}
        </button>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-stone-600">
        <input type="checkbox" checked={prefix} onChange={(e) => setPrefix(e.target.checked)} />
        Konuya [TEST] ekle <span className="text-stone-400">(spam testi yaparken kapatın: mail, gerçek gönderimdeki hâliyle gider)</span>
      </label>
      <p className="text-xs text-stone-500">
        Ekrandaki {dirty ? "(kaydedilmemiş) " : ""}hâli, seçili mağazanın verisiyle gönderilir. Gmail, Outlook ve{" "}
        <a href="https://www.mail-tester.com" target="_blank" rel="noreferrer" className="underline">
          mail-tester.com
        </a>{" "}
        adreslerine göndererek spam durumunu kontrol edebilirsiniz.
      </p>
      {state && <p className={`text-[13px] ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Basit içerik ipuçları (kesin spam testi değildir)
// ---------------------------------------------------------------------------

const SPAMMY = /\b(ücretsiz|bedava|garanti|kazan(ın|dınız)?|hemen tıkla|acil|son fırsat|%100|free|guarantee|urgent|act now|winner)\b/i;
const SHORTENER = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|cutt\.ly|shorturl\.at)\//i;
// Ücretsiz hosting alt alan adları oltalamada çok kullanıldığı için filtreler sert davranır
const FREE_HOSTING =
  /\b[a-z0-9-]+\.(vercel\.app|netlify\.app|github\.io|herokuapp\.com|web\.app|firebaseapp\.com|pages\.dev|onrender\.com|wixsite\.com|blogspot\.com|webflow\.io|framer\.website|carrd\.co)\b/i;

function contentHints(
  subject: string,
  text: string,
  html: string | null,
  audience: TemplateAudience,
  source: string,
): { level: "warn" | "bad"; text: string }[] {
  const out: { level: "warn" | "bad"; text: string }[] = [];
  if (audience !== "shopify" && /shopify/i.test(`${subject} ${text} ${html ?? ""}`)) {
    out.push({ level: "warn", text: "Metinde \"Shopify\" geçiyor ama hedef kitle yalnızca Shopify değil; Shopify kullanmayan siteye yanlış gider." });
  }
  if (audience !== "shopify" && audience !== "all" && /\{\{\s*(bulgu|kategori)\b/.test(source)) {
    out.push({ level: "bad", text: "{{bulgu}} / {{kategori}} yalnızca Shopify mağazaları için dolar; bu hedef kitlede boş kalır." });
  }
  if (/\{\{\s*platform\s*\}\}/.test(source)) {
    out.push({ level: "warn", text: "{{platform}} güvenilmez tespitte boş kalır. Yedek değer verin: {{platform|web siteniz}}." });
  }
  const links = (text.match(/https?:\/\/\S+/g) ?? []).length + (html ? (html.match(/<a\s/gi) ?? []).length : 0);
  const words = text.split(/\s+/).filter(Boolean).length;

  if (subject.length > 70) out.push({ level: "warn", text: `Konu uzun (${subject.length} karakter); 30-60 arası daha iyi.` });
  if (/!{2,}|[A-ZÇĞİÖŞÜ]{6,}/.test(subject)) out.push({ level: "warn", text: "Konuda büyük harf veya çoklu ünlem var; spam filtreleri sevmez." });
  if (SPAMMY.test(`${subject} ${text}`)) out.push({ level: "warn", text: "Pazarlama kelimeleri var (ücretsiz, garanti, acil…)." });
  if (SHORTENER.test(`${text} ${html ?? ""}`)) out.push({ level: "bad", text: "Link kısaltıcı (bit.ly vb.) kullanılmış; spam'e düşme riski yüksek." });
  const hosted = `${text} ${html ?? ""}`.match(FREE_HOSTING);
  if (hosted) {
    out.push({
      level: "bad",
      text: `"${hosted[0]}" ücretsiz hosting adresi. Bu tür linkler oltalamada çok kullanıldığı için spam filtreleri sert davranır; kendi alan adınızı ya da LinkedIn'i kullanın veya ilk mailde link vermeyin.`,
    });
  }
  if (links > 3) out.push({ level: "warn", text: `${links} link var; soğuk mailde 1-3 link önerilir.` });
  if (words > 180) out.push({ level: "warn", text: `Metin uzun (${words} kelime); soğuk mailde 50-150 kelime daha çok yanıt alır.` });
  if (html && /<img\s/i.test(html)) out.push({ level: "warn", text: "Görsel var; çoğu istemci görselleri varsayılan olarak göstermez ve spam puanını artırır." });
  if (!/çıkar|unsubscribe|abonelik|rahatsız etmem|ilgilenmiyorsanız|istemiyorsanız/i.test(text)) out.push({ level: "warn", text: "Abonelikten çıkma satırı yok (örn. \"almak istemiyorsanız 'çıkar' yazarak yanıtlayın\")." });
  return out;
}
