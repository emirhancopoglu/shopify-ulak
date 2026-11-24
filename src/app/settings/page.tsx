import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { ui } from "@/components/ui";
import { listAccounts } from "@/lib/accounts";
import { listUnsubscribeEnabled } from "@/lib/mailer";
import { CALLBACK_PATH, getOutlookClientId, outlookClientIdFromEnv } from "@/lib/outlook";
import { listSuppression } from "@/lib/suppression";
import { AccountCard, NewAccountForm, NewSmtpAccountForm } from "./account-forms";
import { OutlookSetup } from "./outlook-setup";
import { SendingOptions } from "./sending-options";
import { SuppressionSection } from "./suppression-section";

export default function SettingsPage({ searchParams }: PageProps<"/settings">) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div>
        <h1 className={ui.h1}>Ayarlar</h1>
        <p className={ui.sub}>Gönderen mail hesapları ve asla mail atılmayacak adresler.</p>
      </div>
      <Suspense fallback={<div className={`${ui.card} h-64 animate-pulse`} />}>
        <SettingsContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function SettingsContent({ searchParams }: { searchParams: PageProps<"/settings">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const accounts = listAccounts();
  const suppressed = listSuppression();
  const clientId = getOutlookClientId();
  // Azure'a kaydedilecek dönüş adresi, uygulamanın açıldığı adresle birebir aynı olmalı
  const host = (await headers()).get("host") ?? "localhost:3000";
  const redirectUri = `http://${host}${CALLBACK_PATH}`;

  const connected = one(sp.outlook_connected);
  const outlookError = one(sp.outlook_error);

  return (
    <>
      {connected && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900">
          {one(sp.outlook_reconnected) ? "Yeniden bağlandı" : "Outlook hesabı bağlandı"}: <b>{connected}</b>. Gönderen adını, imzayı ve günlük limiti aşağıdan
          düzenleyebilirsiniz.
        </div>
      )}
      {outlookError && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">Outlook bağlanamadı: {outlookError}</div>}

      <section className="flex flex-col gap-3">
        <div>
          <h2 className={ui.h2}>Gönderen hesaplar</h2>
          <p className={ui.sub}>Kampanyalar bu hesaplardan gönderilir. İmza, şablondaki {"{{imza}}"} yerine geçer.</p>
        </div>
        {accounts.map((a) => (
          <AccountCard key={a.id} account={a} />
        ))}
        {accounts.length === 0 && (
          <p className="rounded-md border border-dashed border-stone-300 px-4 py-3 text-stone-500">
            Henüz hesap yok. Gmail, Outlook ya da kurumsal mail (SMTP) bağlayın.
          </p>
        )}
        <NewAccountForm first={false} />
        <NewSmtpAccountForm />
        <OutlookSetup clientId={clientId} fromEnv={Boolean(outlookClientIdFromEnv())} redirectUri={redirectUri} />
      </section>

      <SendingOptions listUnsubscribe={listUnsubscribeEnabled()} />

      <SuppressionSection items={suppressed} />
    </>
  );
}
