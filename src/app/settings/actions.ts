"use server";

import { refresh } from "next/cache";
import type { FormState } from "@/components/ui";
import { createGmailAccount, createSmtpAccount, deleteAccount, getAccount, updateAccount } from "@/lib/accounts";
import { cleanEmail } from "@/lib/analyzer/emails";
import { classifySendError, LIST_UNSUBSCRIBE_KEY } from "@/lib/mailer";
import { CLIENT_ID_KEY } from "@/lib/outlook";
import { setSetting } from "@/lib/settings";
import { suppress, unsuppress } from "@/lib/suppression";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function parseLimit(fd: FormData): number | null {
  const n = Number(str(fd, "dailyLimit"));
  return Number.isInteger(n) && n >= 1 && n <= 2000 ? n : null;
}

/** Gmail giriş hatalarını kullanıcıya anlaşılır anlat. */
function loginError(err: unknown): string {
  const { kind, message } = classifySendError(err);
  if (kind === "auth") {
    return "Gmail girişi reddedildi. Normal şifrenizi değil, 16 haneli uygulama şifresini girdiğinizden ve 2 adımlı doğrulamanın açık olduğundan emin olun.";
  }
  return `Gmail'e bağlanılamadı: ${message}`;
}

export async function addAccountAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = cleanEmail(str(fd, "email"));
  const fromName = str(fd, "fromName");
  const password = str(fd, "password").replace(/\s+/g, "");
  const dailyLimit = parseLimit(fd);
  if (!email) return { ok: false, message: "Geçerli bir Gmail adresi girin." };
  if (!fromName) return { ok: false, message: "Gönderen adı gerekli (alıcı bu adı görür)." };
  if (password.length !== 16) return { ok: false, message: "Uygulama şifresi 16 karakter olmalı (boşluklar önemli değil)." };
  if (!dailyLimit) return { ok: false, message: "Günlük limit 1 ile 2000 arasında olmalı." };
  try {
    await createGmailAccount({ email, fromName, password, dailyLimit, signature: str(fd, "signature") });
  } catch (err) {
    return { ok: false, message: loginError(err) };
  }
  refresh();
  return { ok: true, message: "Hesap bağlandı ve doğrulandı." };
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/** Kurumsal SMTP sunucu alanlarını (şifre hariç) doğrular. */
function parseSmtpServer(fd: FormData): { host: string; port: number; secure: boolean; user: string } | string {
  const host = str(fd, "host").toLowerCase();
  const port = Number(str(fd, "port"));
  const user = str(fd, "user");
  if (!HOST_RE.test(host)) return "Geçerli bir SMTP sunucu adı girin (ör. mail.alanadiniz.com).";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port 1 ile 65535 arasında olmalı (genelde 465 ya da 587).";
  if (!user || /\s/.test(user)) return "Kullanıcı adı gerekli (genelde tam mail adresi).";
  return { host, port, secure: str(fd, "security") !== "starttls", user };
}

/** Kurumsal SMTP giriş/bağlantı hatalarını kullanıcıya anlaşılır anlat. */
function smtpLoginError(err: unknown): string {
  const { kind, message } = classifySendError(err, "smtp");
  const e = err as { code?: string };
  if (kind === "auth") return "Kurumsal mail girişi reddedildi. Kullanıcı adı (genelde tam mail adresi) ve şifreyi kontrol edin.";
  if (e.code === "ENOTFOUND") return "SMTP sunucusu bulunamadı. Sunucu adını kontrol edin.";
  if (e.code === "ETIMEDOUT" || e.code === "ECONNECTION" || e.code === "ESOCKET") {
    return `SMTP sunucusuna bağlanılamadı (${e.code}). Port ve güvenlik türünü kontrol edin: 465 → SSL/TLS, 587 → STARTTLS.`;
  }
  return `Kurumsal mail sunucusuna bağlanılamadı: ${message}`;
}

export async function addSmtpAccountAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = cleanEmail(str(fd, "email"));
  const fromName = str(fd, "fromName");
  const password = str(fd, "password");
  const dailyLimit = parseLimit(fd);
  const server = parseSmtpServer(fd);
  if (!email) return { ok: false, message: "Geçerli bir mail adresi girin." };
  if (!fromName) return { ok: false, message: "Gönderen adı gerekli (alıcı bu adı görür)." };
  if (typeof server === "string") return { ok: false, message: server };
  if (!password) return { ok: false, message: "Mail şifresi gerekli." };
  if (!dailyLimit) return { ok: false, message: "Günlük limit 1 ile 2000 arasında olmalı." };
  try {
    await createSmtpAccount({ email, fromName, dailyLimit, signature: str(fd, "signature"), ...server, password });
  } catch (err) {
    return { ok: false, message: smtpLoginError(err) };
  }
  refresh();
  return { ok: true, message: "Kurumsal hesap bağlandı ve doğrulandı." };
}

export async function updateAccountAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = Number(fd.get("id"));
  const fromName = str(fd, "fromName");
  const isSmtp = Number.isInteger(id) && getAccount(id)?.provider === "smtp";
  // Gmail uygulama şifresindeki boşluklar önemsiz; kurumsal şifre olduğu gibi kalmalı
  const password = isSmtp ? str(fd, "password") : str(fd, "password").replace(/\s+/g, "");
  const dailyLimit = parseLimit(fd);
  if (!Number.isInteger(id)) return { ok: false, message: "Geçersiz hesap." };
  if (!fromName) return { ok: false, message: "Gönderen adı gerekli." };
  if (!dailyLimit) return { ok: false, message: "Günlük limit 1 ile 2000 arasında olmalı." };
  if (!isSmtp && password && password.length !== 16) return { ok: false, message: "Uygulama şifresi 16 karakter olmalı." };
  const server = isSmtp && fd.has("host") ? parseSmtpServer(fd) : undefined;
  if (typeof server === "string") return { ok: false, message: server };
  try {
    await updateAccount(id, { fromName, dailyLimit, signature: str(fd, "signature"), password: password || undefined, smtp: server });
  } catch (err) {
    const message = err instanceof Error && !("code" in err) ? err.message : isSmtp ? smtpLoginError(err) : loginError(err);
    return { ok: false, message };
  }
  refresh();
  return { ok: true, message: password ? "Kaydedildi, yeni şifre doğrulandı." : "Kaydedildi." };
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveOutlookClientIdAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const clientId = str(fd, "clientId");
  if (!GUID_RE.test(clientId)) {
    return { ok: false, message: "Client ID, 00000000-0000-0000-0000-000000000000 biçiminde olmalı (Application (client) ID)." };
  }
  setSetting(CLIENT_ID_KEY, clientId.toLowerCase());
  refresh();
  return { ok: true, message: "Client ID kaydedildi. Şimdi \"Outlook hesabı bağla\"ya tıklayın." };
}

export async function setListUnsubscribeAction(enabled: boolean) {
  setSetting(LIST_UNSUBSCRIBE_KEY, enabled ? null : "off");
  refresh();
}

export async function deleteAccountAction(id: number) {
  if (!Number.isInteger(id)) return;
  deleteAccount(id);
  refresh();
}

export async function addSuppressionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const emails = str(fd, "emails")
    .split(/[\s,;]+/)
    .map((e) => cleanEmail(e))
    .filter((e): e is string => Boolean(e));
  if (emails.length === 0) return { ok: false, message: "Geçerli mail adresi bulunamadı." };
  for (const e of emails) suppress(e, "manual", str(fd, "note") || undefined);
  refresh();
  return { ok: true, message: `${emails.length} adres kara listeye eklendi.` };
}

export async function removeSuppressionAction(email: string) {
  if (typeof email !== "string") return;
  unsuppress(email);
  refresh();
}
