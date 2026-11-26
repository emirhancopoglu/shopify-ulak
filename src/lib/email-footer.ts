// Mail alt bilgisi (HTML): Ayarlar'da girilir, tüm maillerin altına eklenir. kv `email_footer_html`.
import { getSetting, setSetting } from "@/lib/settings";

export const EMAIL_FOOTER_KEY = "email_footer_html";
/** Bir kez yazıldı işareti. Kullanıcı alt bilgiyi silerse varsayılan geri gelmez. */
export const EMAIL_FOOTER_SEEDED_KEY = "email_footer_default_v1";
export const EMAIL_FOOTER_MAX = 20_000;

/** Yeni kurulumda kullanılan alt bilgi. Ayarlar'dan değiştirilebilir veya silinebilir. */
export const DEFAULT_EMAIL_FOOTER = `<tr>
  <td style="padding-top:28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <!-- Tek ince ayırıcı -->
      <tr>
        <td style="height:1px;line-height:1px;font-size:0;background:#e6e6e9;">&nbsp;</td>
      </tr>

      <!-- Logo + marka -->
      <tr>
        <td style="padding-top:20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
            <tr>
              <td width="40" valign="middle" style="width:40px;padding:0;">
                <img src="https://www.dijitalcraft.com/email/dijitalcraft-mark.png" width="40" height="40" alt="Dijital Craft" style="display:block;width:40px;height:40px;border:0;border-radius:8px;">
              </td>
              <td valign="middle" style="padding:0 0 0 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <div style="font-size:15px;line-height:20px;font-weight:600;color:#1c1c1f;">Dijital Craft</div>
                <div style="font-size:13px;line-height:18px;color:#6b6b76;">Özel Yazılım &amp; Dijital Ürün Çözümleri</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Linkler -->
      <tr>
        <td style="padding-top:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#c4c4cb;">
          <a href="https://www.dijitalcraft.com" style="color:#1c1c1f;text-decoration:none;">dijitalcraft.com</a>
          &nbsp;&nbsp;|&nbsp;&nbsp;
          <a href="mailto:info@dijitalcraft.com" style="color:#1c1c1f;text-decoration:none;">info@dijitalcraft.com</a>
          &nbsp;&nbsp;|&nbsp;&nbsp;
          <a href="https://www.instagram.com/dijitalcraftcom/" style="color:#1c1c1f;text-decoration:none;">Instagram</a>
        </td>
      </tr>
    </table>
  </td>
</tr>`;

/** Kayıt yoksa varsayılan alt bilgiyi bir kez yazar. */
export function ensureDefaultEmailFooter() {
  if (getSetting(EMAIL_FOOTER_SEEDED_KEY) === "done") return;
  const current = getSetting(EMAIL_FOOTER_KEY);
  if (!current?.trim()) setSetting(EMAIL_FOOTER_KEY, DEFAULT_EMAIL_FOOTER);
  setSetting(EMAIL_FOOTER_SEEDED_KEY, "done");
}

/** Kayıtlı alt bilgi HTML'i; yoksa null. */
export function getEmailFooter(): string | null {
  ensureDefaultEmailFooter();
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
