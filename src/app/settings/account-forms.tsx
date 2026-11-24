"use client";

import { useActionState, useState, useTransition } from "react";
import { ui, type FormState } from "@/components/ui";
import type { AccountView } from "@/lib/accounts";
import { addAccountAction, addSmtpAccountAction, deleteAccountAction, updateAccountAction } from "./actions";

const SIGNATURE_PLACEHOLDER = "Ad Soyad\nShopify Geliştirici\nhttps://portfolyo-siteniz.com\nhttps://linkedin.com/in/profiliniz";

export function NewAccountForm({ first }: { first: boolean }) {
  const [open, setOpen] = useState(first);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, fd) => {
    const r = await addAccountAction(prev, fd);
    if (r?.ok) setOpen(false);
    return r;
  }, null);

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(true)} className={ui.btn}>
          + Gmail hesabı ekle
        </button>
        {state?.ok && <span className="text-emerald-700">{state.message}</span>}
      </div>
    );
  }

  return (
    <form action={action} className={`${ui.card} flex flex-col gap-4 p-5`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Gmail hesabı bağla</h3>
        {!first && (
          <button type="button" onClick={() => setOpen(false)} className="text-stone-500 hover:text-stone-900">
            Vazgeç
          </button>
        )}
      </div>

      <details className="rounded-md bg-amber-50 px-4 py-3 text-[13px] text-amber-950" open={first}>
        <summary className="cursor-pointer font-medium">Uygulama şifresi nasıl alınır? (2 dakika)</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Google Hesabı → Güvenlik bölümünde <b>2 Adımlı Doğrulama</b>&apos;yı açın.
          </li>
          <li>
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="underline">
              myaccount.google.com/apppasswords
            </a>{" "}
            adresine gidin.
          </li>
          <li>Uygulama adı olarak &quot;Mail Templater&quot; yazıp oluşturun.</li>
          <li>Gösterilen 16 harfli şifreyi aşağıya yapıştırın. Normal Gmail şifreniz çalışmaz.</li>
        </ol>
        <p className="mt-2">
          Öneri: ana hesabınız yerine soğuk mail için ayrı bir Gmail hesabı kullanın. Şifre bu bilgisayarda şifrelenmiş olarak saklanır.
        </p>
      </details>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Gmail adresi">
          <input name="email" type="email" required autoComplete="off" placeholder="adiniz@gmail.com" className={ui.input} />
        </Field>
        <Field label="Gönderen adı" hint="Alıcının gelen kutusunda görünen ad">
          <input name="fromName" required placeholder="Ad Soyad" className={ui.input} />
        </Field>
        <Field label="Uygulama şifresi">
          <input name="password" type="password" required autoComplete="new-password" placeholder="abcd efgh ijkl mnop" className={`${ui.input} font-mono`} />
        </Field>
        <Field label="Günlük limit (24 saat)" hint="Gmail sınırı ~500. Güvenli tavsiye: 400, yeni hesapta daha az.">
          <input name="dailyLimit" type="number" min={1} max={2000} defaultValue={400} className={ui.input} />
        </Field>
      </div>
      <SignatureField />

      <div className="flex items-center gap-3">
        <button disabled={pending} className={ui.btnPrimary}>
          {pending ? "Gmail'e bağlanılıyor…" : "Bağlan ve kaydet"}
        </button>
        {state && <span className={state.ok ? "text-emerald-700" : "text-red-700"}>{state.message}</span>}
      </div>
    </form>
  );
}

export function NewSmtpAccountForm() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, fd) => {
    const r = await addSmtpAccountAction(prev, fd);
    if (r?.ok) setOpen(false);
    return r;
  }, null);

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(true)} className={ui.btn}>
          + Kurumsal mail (SMTP) ekle
        </button>
        {state?.ok && <span className="text-emerald-700">{state.message}</span>}
      </div>
    );
  }

  return (
    <form action={action} className={`${ui.card} flex flex-col gap-4 p-5`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Kurumsal mail (SMTP) bağla</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-stone-500 hover:text-stone-900">
          Vazgeç
        </button>
      </div>

      <details className="rounded-md bg-amber-50 px-4 py-3 text-[13px] text-amber-950">
        <summary className="cursor-pointer font-medium">Bilgileri nereden bulurum?</summary>
        <p className="mt-2">
          Hosting firmanızın webmail ya da e-posta paneli, mail hesabı için &quot;SMTP yapılandırması&quot; (giden posta) bilgilerini gösterir: sunucu adı,
          port ve güvenlik türü. Kullanıcı adı genelde tam mail adresidir; şifre mail hesabının şifresidir. Bilgiler bu bilgisayarda şifrelenmiş
          olarak saklanır.
        </p>
        <p className="mt-2">
          Kurumsal alan adından toplu gönderim, alan adının itibarını etkileyebilir. Günlük limiti düşük tutun ve hosting panelinde SPF/DKIM kayıtlarının
          açık olduğundan emin olun.
        </p>
      </details>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mail adresi">
          <input name="email" type="email" required autoComplete="off" placeholder="info@alanadiniz.com" className={ui.input} />
        </Field>
        <Field label="Gönderen adı" hint="Alıcının gelen kutusunda görünen ad">
          <input name="fromName" required placeholder="Ad Soyad" className={ui.input} />
        </Field>
        <Field label="SMTP sunucusu">
          <input name="host" required autoComplete="off" placeholder="mail.alanadiniz.com" className={ui.input} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Port">
            <input name="port" type="number" min={1} max={65535} required defaultValue={465} className={ui.input} />
          </Field>
          <Field label="Güvenlik">
            <select name="security" defaultValue="ssl" className={ui.input}>
              <option value="ssl">SSL / TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </Field>
        </div>
        <Field label="Kullanıcı adı" hint="Genelde tam mail adresi">
          <input name="user" required autoComplete="off" placeholder="info@alanadiniz.com" className={ui.input} />
        </Field>
        <Field label="Mail şifresi">
          <input name="password" type="password" required autoComplete="new-password" className={`${ui.input} font-mono`} />
        </Field>
        <Field label="Günlük limit (24 saat)" hint="Hosting firmasının limitini sorun; bilmiyorsanız düşük başlayın.">
          <input name="dailyLimit" type="number" min={1} max={2000} defaultValue={100} className={ui.input} />
        </Field>
      </div>
      <SignatureField />

      <div className="flex items-center gap-3">
        <button disabled={pending} className={ui.btnPrimary}>
          {pending ? "Sunucuya bağlanılıyor…" : "Bağlan ve kaydet"}
        </button>
        {state && <span className={state.ok ? "text-emerald-700" : "text-red-700"}>{state.message}</span>}
      </div>
    </form>
  );
}

export function AccountCard({ account }: { account: AccountView }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, fd) => {
    const r = await updateAccountAction(prev, fd);
    if (r?.ok) setEditing(false);
    return r;
  }, null);
  const [deleting, startDelete] = useTransition();
  const pct = Math.min(100, Math.round((account.sent24h / account.dailyLimit) * 100));

  return (
    <div className={`${ui.card} p-5`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {account.provider === "outlook" ? (
              <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700">OUTLOOK</span>
            ) : account.provider === "smtp" ? (
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">KURUMSAL</span>
            ) : (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">GMAIL</span>
            )}
            <span className="font-medium">{account.fromName}</span>
            <span className="truncate text-stone-500">&lt;{account.email}&gt;</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[13px] text-stone-600">
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-stone-100">
              <div className={`h-full ${pct >= 90 ? "bg-red-500" : "bg-stone-800"}`} style={{ width: `${pct}%` }} />
            </div>
            Son 24 saat: <b className="tabular-nums">{account.sent24h}</b> / {account.dailyLimit}
          </div>
          {account.smtp && !editing && (
            <p className="mt-1 text-[13px] text-stone-500">
              {account.smtp.host}:{account.smtp.port} · {account.smtp.secure ? "SSL/TLS" : "STARTTLS"}
            </p>
          )}
          {account.lastError && <p className="mt-2 text-[13px] text-red-700">⚠ {account.lastError}</p>}
        </div>
        {!editing && (
          <div className="flex gap-2">
            {account.provider === "outlook" && (
              <a href="/api/oauth/outlook/start" className={ui.btn} title="Microsoft oturumu düştüyse ya da izin geri alındıysa">
                Yeniden bağlan
              </a>
            )}
            <button onClick={() => setEditing(true)} className={ui.btn}>
              Düzenle
            </button>
            <button
              disabled={deleting}
              onClick={() =>
                confirm(`${account.email} silinsin mi? Bu hesabı kullanan çalışan kampanyalar duraklatılır.`) &&
                startDelete(() => deleteAccountAction(account.id))
              }
              className={ui.btnDanger}
            >
              Sil
            </button>
          </div>
        )}
      </div>

      {!editing && account.signature && (
        <pre className="mt-3 rounded-md bg-stone-50 px-3 py-2 font-sans text-[13px] whitespace-pre-wrap text-stone-600">{account.signature}</pre>
      )}

      {editing && (
        <form action={action} className="mt-4 flex flex-col gap-4 border-t border-stone-100 pt-4">
          <input type="hidden" name="id" value={account.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Gönderen adı">
              <input name="fromName" required defaultValue={account.fromName} className={ui.input} />
            </Field>
            <Field
              label="Günlük limit (24 saat)"
              hint={account.provider === "outlook" ? "Microsoft net limit yayınlamıyor; yeni kişisel hesapta 100-150 güvenli." : undefined}
            >
              <input name="dailyLimit" type="number" min={1} max={2000} defaultValue={account.dailyLimit} className={ui.input} />
            </Field>
            {account.provider === "gmail" && (
              <Field label="Yeni uygulama şifresi" hint="Değiştirmeyecekseniz boş bırakın">
                <input name="password" type="password" autoComplete="new-password" className={`${ui.input} font-mono`} />
              </Field>
            )}
            {account.provider === "smtp" && account.smtp && (
              <>
                <Field label="SMTP sunucusu">
                  <input name="host" required defaultValue={account.smtp.host} className={ui.input} />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Port">
                    <input name="port" type="number" min={1} max={65535} required defaultValue={account.smtp.port} className={ui.input} />
                  </Field>
                  <Field label="Güvenlik">
                    <select name="security" defaultValue={account.smtp.secure ? "ssl" : "starttls"} className={ui.input}>
                      <option value="ssl">SSL / TLS</option>
                      <option value="starttls">STARTTLS</option>
                    </select>
                  </Field>
                </div>
                <Field label="Kullanıcı adı">
                  <input name="user" required defaultValue={account.smtp.user} className={ui.input} />
                </Field>
                <Field label="Yeni şifre" hint="Değiştirmeyecekseniz boş bırakın">
                  <input name="password" type="password" autoComplete="new-password" className={`${ui.input} font-mono`} />
                </Field>
              </>
            )}
          </div>
          <SignatureField defaultValue={account.signature} />
          <div className="flex items-center gap-3">
            <button disabled={pending} className={ui.btnPrimary}>
              {pending ? "Kaydediliyor…" : "Kaydet"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={ui.btn}>
              Vazgeç
            </button>
            {state && !state.ok && <span className="text-red-700">{state.message}</span>}
          </div>
        </form>
      )}
      {!editing && state?.ok && <p className="mt-2 text-[13px] text-emerald-700">{state.message}</p>}
    </div>
  );
}

function SignatureField({ defaultValue }: { defaultValue?: string }) {
  return (
    <Field label="İmza" hint="Düz metin. Ad soyad, unvan, en fazla 2-3 link (portfolyo, LinkedIn). Link kısaltıcı kullanmayın.">
      <textarea name="signature" rows={4} defaultValue={defaultValue} placeholder={SIGNATURE_PLACEHOLDER} className={`${ui.textarea} text-[13px]`} />
    </Field>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={ui.label}>{label}</span>
      {children}
      {hint && <span className={`${ui.hint} block`}>{hint}</span>}
    </label>
  );
}
