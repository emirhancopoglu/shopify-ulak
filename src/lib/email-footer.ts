// Mail alt bilgisi (HTML): Ayarlar'da girilir, tüm maillerin altına eklenir. kv `email_footer_html`.
import { getSetting, setSetting } from "@/lib/settings";

export const EMAIL_FOOTER_KEY = "email_footer_html";
export const EMAIL_FOOTER_MAX = 20_000;

/** Kayıtlı alt bilgi HTML'i; yoksa null. */
export function getEmailFooter(): string | null {
  return getSetting(EMAIL_FOOTER_KEY)?.trim() || null;
}

/** Alt bilgiyi kaydeder (boş = kaldır). Geçersizse Türkçe hata mesajı döner. */
export function saveEmailFooter(html: string): { ok: true } | { ok: false; message: string } {
  const value = html.trim();
  if (value.length > EMAIL_FOOTER_MAX) return { ok: false, message: `Alt bilgi çok uzun (en fazla ${EMAIL_FOOTER_MAX.toLocaleString("tr-TR")} karakter).` };
  if (/<\s*(script|iframe|object|embed|form)\b/i.test(value)) {
    return { ok: false, message: "Alt bilgide script, iframe, form gibi etiketler olamaz; mail istemcileri bunları zaten engeller ve spam puanını artırır." };
  }
  setSetting(EMAIL_FOOTER_KEY, value || null);
  return { ok: true };
}
