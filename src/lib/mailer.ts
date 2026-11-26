import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import type { Account } from "@/db/schema";
import { OutlookAuthError, outlookAccessToken } from "@/lib/outlook";
import { decrypt, encrypt } from "@/lib/secret";
import { getSetting } from "@/lib/settings";
import { inlineRemoteImages, type FetchImageFn } from "@/lib/inline-images";

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
export type ImapSettings = { host: string; port: number; secure: boolean };
/** Opsiyonel IMAP ayarı. Yoksa SMTP sunucusu, 993 port ve SSL varsayılır (hosting'lerde genellikle aynı host). */
export type SmtpConfig = { host: string; port: number; secure: boolean; user: string; password: string; imap?: ImapSettings };

export const encodeSmtpSecret = (cfg: SmtpConfig) => encrypt(JSON.stringify(cfg));

export function decodeSmtpSecret(secret: string): SmtpConfig {
  const cfg = JSON.parse(decrypt(secret)) as Partial<SmtpConfig>;
  if (!cfg.host || !cfg.port || !cfg.user || !cfg.password) throw new Error("Kurumsal SMTP hesabının bilgileri okunamadı; hesabı silip yeniden ekleyin.");
  const imap = cfg.imap?.host ? { host: cfg.imap.host, port: cfg.imap.port || 993, secure: cfg.imap.secure !== false } : undefined;
  return { host: cfg.host, port: cfg.port, secure: Boolean(cfg.secure), user: cfg.user, password: cfg.password, ...(imap ? { imap } : {}) };
}

/** Gönderilenler kopyası için kullanılacak IMAP ayarı. */
export const imapSettingsFor = (cfg: SmtpConfig): ImapSettings => cfg.imap ?? { host: cfg.host, port: 993, secure: true };

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

/** Gönderilenler kopyasını IMAP ile yazar. Verilirse sendEmail bunu kullanır (test için enjekte edilebilir). */
export type AppendSentFn = (cfg: SmtpConfig, raw: Buffer) => Promise<unknown>;

const SENT_FOLDER_NAMES = ["sent", "sent items", "sent messages", "gönderilmiş", "gönderilenler", "gönderilmiş öğeler", "inbox.sent", "[gmail]/sent mail"];

/** Gönderilenler klasörüne mesajın bir kopyasını ekler. Klasörü önce SPECIAL-USE (\Sent), sonra bilinen adlarla bulur. */
export async function appendToSentFolder(cfg: SmtpConfig, raw: Buffer): Promise<string> {
  const imap = imapSettingsFor(cfg);
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: cfg.user, pass: cfg.password },
    tls: { rejectUnauthorized: true },
    logger: false,
    disableAutoIdle: true,
    ...TIMEOUTS,
  });
  await client.connect();
  try {
    const folders = await client.list();
    const sent =
      folders.find((f) => f.specialUse === "\\Sent") ?? folders.find((f) => SENT_FOLDER_NAMES.includes(f.path.toLowerCase()));
    if (!sent) throw new Error("IMAP'te Gönderilmiş klasörü bulunamadı.");
    await client.append(sent.path, raw, ["\\Seen"]);
    return sent.path;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** SMTP ile gönderilen mesajın birebir aynı içeriğini (Message-ID dahil) ham MIME olarak üretir. */
async function buildRawMessage(opts: Record<string, unknown>): Promise<Buffer> {
  // IMAP APPEND literal'i CRLF satır sonu bekler (RFC 3501)
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await composer.sendMail(opts);
  return info.message as Buffer;
}

export async function sendEmail(
  account: Account,
  mail: OutgoingEmail,
  deps: { appendSent?: AppendSentFn | null; fetchImage?: FetchImageFn | null } = {},
): Promise<{ messageId: string }> {
  const t = await transportFor(account);
  // Kurumsal SMTP'de gönderilenler klasörüne kopya yazılmaz; IMAP APPEND ile eklenir.
  // Kuru modda (MAIL_TRANSPORT=json) gerçek IMAP'a bağlanılmaz ve dış görseller indirilmez.
  const appendSent: AppendSentFn | null =
    deps.appendSent !== undefined ? deps.appendSent : DRY_RUN ? null : appendToSentFolder;
  const shouldInline = mail.html && (deps.fetchImage !== undefined ? deps.fetchImage !== null : !DRY_RUN);
  const inlined = shouldInline
    ? await inlineRemoteImages(mail.html!, deps.fetchImage ? { fetchImage: deps.fetchImage } : {})
    : { html: mail.html, attachments: [] };
  try {
    // Date'i biz veriyoruz ki SMTP'de giden ve IMAP'a yazılan kopya aynı tarihi taşısın
    const mailOpts = {
      from: { name: account.fromName, address: account.email },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      date: new Date(),
      ...(inlined.html ? { html: inlined.html } : {}),
      ...(inlined.attachments.length ? { attachments: inlined.attachments } : {}),
      // Gmail/Outlook "abonelikten çık" bağlantısını bu başlıktan gösterir
      ...(listUnsubscribeEnabled() ? { headers: { "List-Unsubscribe": `<mailto:${account.email}?subject=unsubscribe>` } } : {}),
    };
    const info = await t.sendMail(mailOpts);

    if (account.provider === "smtp" && appendSent) {
      // Gönderim başarılı. Kopyanın hatası gönderimi bozmamalı, sadece loglanır.
      try {
        const cfg = decodeSmtpSecret(account.secret);
        const raw = await buildRawMessage({ ...mailOpts, messageId: info.messageId });
        await appendSent(cfg, raw);
      } catch (err) {
        console.warn(`[imap] ${account.email} gönderilenler kopyası eklenemedi: ${(err as Error).message}`);
      }
    }
    return { messageId: info.messageId };
  } finally {
    t.close();
  }
}

export type SendErrorKind =
  | "auth" // giriş başarısız: kampanyayı durdur
  | "quota" // sağlayıcı limiti / hesap engeli: kampanyayı durdur
  | "policy" // içerik / güvenlik politikası engeli (örn. DATA 550 5.7.1): tekrar deneme, kampanyayı durdur
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
  // İçerik / güvenlik politikası engeli (örn. DATA aşamasında 550 5.7.1): tekrar denemek işe yaramaz
  if (
    e.responseCode &&
    e.responseCode >= 550 &&
    (e.command === "DATA" ||
      /\b5\.7\.1\b|blocked due to security|security reason|policy|rejected as spam|content rejected|message (is )?blocked|message rejected/i.test(text))
  ) {
    return {
      kind: "policy",
      message: withRaw(
        `${name} bu mesajı güvenlik/içerik politikası nedeniyle engelledi. İçeriği ve SPF/DKIM/DMARC kayıtlarını kontrol etmeden devam etmeyin.`,
      ),
    };
  }
  return { kind: "transient", message: (e.response ?? e.message ?? String(err)).slice(0, 300) };
}
