import nodemailer from "nodemailer";
import type { Account } from "@/db/schema";
import { OutlookAuthError, outlookAccessToken } from "@/lib/outlook";
import { decrypt, encrypt } from "@/lib/secret";
import { getSetting } from "@/lib/settings";

/**
 * "Abonelikten çık" (List-Unsubscribe) başlığı. Google bunu yalnızca günde 5000+ gönderenlere zorunlu tutar;
 * az sayıda kişisel görünmesi gereken mailde toplu mail sinyali olabildiği için kapatılabilir. Varsayılan: açık.
 */
export const LIST_UNSUBSCRIBE_KEY = "list_unsubscribe_header";
export const listUnsubscribeEnabled = () => getSetting(LIST_UNSUBSCRIBE_KEY) !== "off";

/**
 * Gönderim: Gmail (SMTP + uygulama şifresi) ve kişisel Outlook (SMTP + OAuth2/XOAUTH2).
 * Geliştirme/test: MAIL_TRANSPORT=json iken hiçbir mail ağa çıkmaz (Nodemailer sadece mesajı oluşturur).
 */
const DRY_RUN = process.env.MAIL_TRANSPORT === "json";

const TIMEOUTS = { connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000 };

export const PROVIDER_LABEL: Record<Account["provider"], string> = { gmail: "Gmail", outlook: "Outlook", smtp: "Kurumsal mail" };

/**
 * Kurumsal (genel) SMTP hesabı: hosting firmasının verdiği sunucu bilgileri.
 * secure=true → doğrudan SSL/TLS (genelde 465); false → STARTTLS (genelde 587).
 */
export type SmtpConfig = { host: string; port: number; secure: boolean; user: string; password: string };

export const encodeSmtpSecret = (cfg: SmtpConfig) => encrypt(JSON.stringify(cfg));

export function decodeSmtpSecret(secret: string): SmtpConfig {
  const cfg = JSON.parse(decrypt(secret)) as Partial<SmtpConfig>;
  if (!cfg.host || !cfg.port || !cfg.user || !cfg.password) throw new Error("Kurumsal SMTP hesabının bilgileri okunamadı; hesabı silip yeniden ekleyin.");
  return { host: cfg.host, port: cfg.port, secure: Boolean(cfg.secure), user: cfg.user, password: cfg.password };
}

export function smtpTransport(cfg: SmtpConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    ...TIMEOUTS,
  });
}

function gmailTransport(email: string, password: string) {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: email, pass: password.replace(/\s+/g, "") },
    ...TIMEOUTS,
  });
}

export function outlookTransport(email: string, accessToken: string) {
  return nodemailer.createTransport({
    host: "smtp-mail.outlook.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { type: "OAuth2", user: email, accessToken },
    ...TIMEOUTS,
  });
}

async function transportFor(account: Account) {
  if (DRY_RUN) return nodemailer.createTransport({ jsonTransport: true });
  if (account.provider === "gmail") return gmailTransport(account.email, decrypt(account.secret));
  if (account.provider === "outlook") return outlookTransport(account.email, await outlookAccessToken(account));
  if (account.provider === "smtp") return smtpTransport(decodeSmtpSecret(account.secret));
  throw new Error(`Desteklenmeyen sağlayıcı: ${account.provider}`);
}

/** Gmail uygulama şifresini kaydetmeden önce dener. */
export async function verifyGmail(email: string, password: string) {
  if (DRY_RUN) return;
  const t = gmailTransport(email, password);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

/** Kurumsal SMTP sunucusuna bağlanıp girişi kaydetmeden önce dener. */
export async function verifySmtp(cfg: SmtpConfig) {
  if (DRY_RUN) return;
  const t = smtpTransport(cfg);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

/** Outlook OAuth erişim anahtarıyla SMTP girişini dener. */
export async function verifyOutlook(email: string, accessToken: string) {
  if (DRY_RUN) return;
  const t = outlookTransport(email, accessToken);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

export type OutgoingEmail = { to: string; subject: string; text: string; html: string | null };

export async function sendEmail(account: Account, mail: OutgoingEmail): Promise<{ messageId: string }> {
  const t = await transportFor(account);
  try {
    const info = await t.sendMail({
      from: { name: account.fromName, address: account.email },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      // Gmail/Outlook "abonelikten çık" bağlantısını bu başlıktan gösterir
      ...(listUnsubscribeEnabled() ? { headers: { "List-Unsubscribe": `<mailto:${account.email}?subject=unsubscribe>` } } : {}),
    });
    return { messageId: info.messageId };
  } finally {
    t.close();
  }
}

export type SendErrorKind =
  | "auth" // giriş başarısız: kampanyayı durdur
  | "quota" // sağlayıcı limiti / hesap engeli: kampanyayı durdur
  | "recipient" // alıcı adresi kalıcı reddedildi: alıcıyı başarısız say, kara listeye al
  | "transient"; // geçici: sonra tekrar dene

export function classifySendError(err: unknown, provider: Account["provider"] = "gmail"): { kind: SendErrorKind; message: string } {
  const e = err as { code?: string; responseCode?: number; command?: string; response?: string; message?: string };
  const text = `${e.response ?? ""} ${e.message ?? ""}`;
  const name = PROVIDER_LABEL[provider];
  // Teşhis için sunucunun ham yanıtı (kısaltılmış) mesajın sonuna eklenir
  const raw = (e.response ?? e.message ?? "").replace(/\[[^\]]{40,}\]/g, "[…]").replace(/\s+/g, " ").trim().slice(0, 180);
  const withRaw = (msg: string) => (raw ? `${msg} — Sunucu yanıtı: ${raw}` : msg);

  // Outlook token hataları zaten Türkçe ve açıklayıcı
  if (err instanceof OutlookAuthError) return { kind: "auth", message: err.message };

  // Outlook: gönderen adres, giriş yapılan hesabın adresi değil
  if (/SendAsDenied/i.test(text)) {
    return {
      kind: "auth",
      message: withRaw(`${name} bu adresle gönderime izin vermedi. Gönderen adres, Microsoft'a giriş yaptığınız hesabın birincil adresi olmalı; hesabı yeniden bağlayın.`),
    };
  }
  // Outlook: hesap spam şüphesiyle gönderimden engellendi (en sık görülen durum)
  if (/OutboundSpamException|WASCL|5\.7\.(520|708)|AS\(842\)/i.test(text)) {
    return {
      kind: "quota",
      message: withRaw(
        `${name} hesabı gönderimden geçici olarak engellendi (spam şüphesi). outlook.com'a girip hesabı doğrulayın, bir gün bekleyin ve saatlik hızı düşürün.`,
      ),
    };
  }
  if (e.code === "EAUTH" || e.responseCode === 535 || e.responseCode === 534) {
    return {
      kind: "auth",
      message:
        provider === "gmail"
          ? "Gmail girişi reddedildi. Uygulama şifresini Ayarlar'dan kontrol edin."
          : provider === "smtp"
            ? "Kurumsal mail girişi reddedildi. Ayarlar'dan kullanıcı adı ve şifreyi kontrol edin."
            : "Outlook girişi reddedildi. Ayarlar'dan hesabı yeniden bağlayın.",
    };
  }
  // Kurumsal SMTP: gönderen adres reddedildi / röle izni yok (MAIL FROM aşaması) → tekrar denemek işe yaramaz
  if (provider === "smtp" && e.command === "MAIL FROM" && e.responseCode && e.responseCode >= 500) {
    return {
      kind: "auth",
      message: withRaw(`${name} sunucusu gönderen adresi kabul etmedi. Kullanıcı adının gönderen adresle uyuştuğundan emin olun.`),
    };
  }
  if (
    /5\.4\.5|sending limit|daily user sending quota|rate limit|4\.7\.0.*(limit|unusual)|5\.5\.0.*daily|exceeded.*(limit|quota)|too many (emails|messages)|max(imum)? .*(emails|messages).*(hour|day)|hourly limit/i.test(
      text,
    )
  ) {
    return { kind: "quota", message: withRaw(`${name} gönderim limitine takıldı. Bir süre bekleyip devam ettirin.`) };
  }
  if (e.responseCode && e.responseCode >= 550 && e.command === "RCPT TO") {
    return { kind: "recipient", message: `Alıcı reddedildi: ${(e.response ?? e.message ?? "").slice(0, 200)}` };
  }
  return { kind: "transient", message: (e.response ?? e.message ?? String(err)).slice(0, 300) };
}
