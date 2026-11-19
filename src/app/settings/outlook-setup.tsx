"use client";

import { useActionState, useState } from "react";
import { ui, type FormState } from "@/components/ui";
import { saveOutlookClientIdAction } from "./actions";

/** Azure arayüzü İngilizce açılırsa diye menü adının İngilizcesi. */
function En({ children }: { children: React.ReactNode }) {
  return <span className="text-sky-900/60">({children})</span>;
}

/**
 * Kişisel Outlook bağlantısı: (1) bir kerelik Azure uygulama kaydı → Client ID, (2) "Outlook hesabı bağla".
 */
export function OutlookSetup({ clientId, fromEnv, redirectUri }: { clientId: string | null; fromEnv: boolean; redirectUri: string }) {
  const [editing, setEditing] = useState(!clientId);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, fd) => {
    const r = await saveOutlookClientIdAction(prev, fd);
    if (r?.ok) setEditing(false);
    return r;
  }, null);

  if (clientId && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {/* Tam sayfa yönlendirme gerekir (Microsoft giriş sayfası), bu yüzden <Link> değil <a> */}
        <a href="/api/oauth/outlook/start" className={ui.btn}>
          + Outlook hesabı bağla
        </a>
        <span className="text-xs text-stone-500">
          Client ID: <code className="font-mono">{clientId.slice(0, 8)}…</code>{" "}
          {fromEnv ? (
            <span title="Değiştirmek için .env dosyasındaki OUTLOOK_CLIENT_ID değerini düzenleyip uygulamayı yeniden başlatın">(.env dosyasından)</span>
          ) : (
            <button onClick={() => setEditing(true)} className="underline hover:text-stone-900">
              değiştir
            </button>
          )}
        </span>
        {state?.ok && <span className="text-[13px] text-emerald-700">{state.message}</span>}
      </div>
    );
  }

  return (
    <div className={`${ui.card} flex flex-col gap-4 p-5`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Outlook (kişisel) bağlantısını kur</h3>
        {clientId && (
          <button onClick={() => setEditing(false)} className="text-stone-500 hover:text-stone-900">
            Vazgeç
          </button>
        )}
      </div>

      <div className="rounded-md bg-sky-50 px-4 py-3 text-[13px] text-sky-950">
        <p className="font-medium">Bir kerelik kurulum (~5 dk, ücretsiz)</p>
        <p className="mt-1">
          Microsoft, kişisel hesaplarda şifreyle gönderimi kapattığı için uygulamanın Microsoft&apos;a kendini tanıtması gerekiyor. Bunun için
          Azure&apos;da bir &quot;uygulama kaydı&quot; oluşturup Client ID&apos;sini buraya yapıştıracaksınız.
        </p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5">
          <li>
            <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer" className="underline">
              Microsoft Entra → Uygulama kayıtları
            </a>{" "}
            <En>App registrations</En> sayfasını açın ve Outlook hesabınızla giriş yapın. Sayfa açılmazsa{" "}
            <a href="https://portal.azure.com" target="_blank" rel="noreferrer" className="underline">
              portal.azure.com
            </a>{" "}
            üst arama kutusuna &quot;Uygulama kayıtları&quot; yazın.
          </li>
          <li>
            <b>Yeni kayıt</b> <En>New registration</En> → <b>Ad</b>: <code>Mail Templater</code>
          </li>
          <li>
            <b>Desteklenen hesap türleri</b> <En>Supported account types</En> → <b>Yalnızca kişisel hesaplar</b>{" "}
            <En>Personal Microsoft accounts only</En>
            <span className="mt-1 block rounded bg-amber-100 px-2 py-1 text-amber-950">
              ⚠ Varsayılan seçenek (<i>Yalnızca tek kiracı - Default Directory</i>) kalırsa Microsoft giriş sayfasında &quot;hesap kiracıda mevcut
              değil… dış kullanıcı olarak eklenmesi gerekiyor&quot; hatası çıkar. Böyle olursa kaydı silip bu seçenekle yeniden oluşturun ve yeni
              kimliği girin.
            </span>
          </li>
          <li>
            <b>Yeniden yönlendirme URI&apos;si</b> <En>Redirect URI</En> → <b>Platform seçin</b>: <b>Genel istemci/yerel (mobil ve masaüstü)</b>{" "}
            <En>Public client/native (mobile &amp; desktop)</En>, yanındaki kutuya şu adresi birebir yapıştırın:
            <div className="mt-1 flex items-center gap-2">
              <code className="rounded bg-white px-2 py-1 font-mono text-[12px] select-all">{redirectUri}</code>
              <button type="button" onClick={() => navigator.clipboard?.writeText(redirectUri)} className="text-xs underline">
                kopyala
              </button>
            </div>
          </li>
          <li>
            <b>Kaydet</b> <En>Register</En> → açılan sayfadaki <b>Uygulama (istemci) kimliği</b> <En>Application (client) ID</En> değerini kopyalayıp
            aşağıya yapıştırın.
          </li>
        </ol>
        <p className="mt-2 text-sky-900/80">
          Gizli anahtar (secret) ya da ek izin eklemeniz gerekmez; izinleri ilk girişte Microsoft size sorar. Azure kayıt sırasında doğrulama
          isteyebilir, ama uygulama kaydı ücretsizdir.
        </p>
      </div>

      <form action={action} className="flex flex-wrap items-start gap-2">
        <input
          name="clientId"
          defaultValue={clientId ?? ""}
          required
          placeholder="00000000-0000-0000-0000-000000000000"
          className={`${ui.input} max-w-sm font-mono text-[13px]`}
        />
        <button disabled={pending} className={ui.btnPrimary}>
          Kaydet
        </button>
        {state && <p className={`w-full text-[13px] ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</p>}
      </form>
    </div>
  );
}
