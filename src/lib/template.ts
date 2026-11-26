/**
 * Şablon motoru. Sözdizimi:
 *   {{marka}}            → değişken
 *   {{marka|merhaba}}    → değişken boşsa "merhaba"
 * Hem sunucu hem tarayıcıda çalışır (canlı önizleme); bağımlılık içermez.
 */
import type { TemplateAudience } from "@/db/schema";

export type TemplateVars = Record<string, string | null | undefined>;

export const VARIABLES: { key: string; label: string; example: string }[] = [
  { key: "marka", label: "Marka adı", example: "Ornek Butik" },
  { key: "site", label: "Alan adı", example: "ornekbutik.com" },
  { key: "url", label: "Site adresi", example: "https://ornekbutik.com" },
  {
    key: "platform",
    label: "Tespit edilen platform (güvenilmezse boş; yedek değer verin)",
    example: "Next.js",
  },
  { key: "kategori", label: "Ana kategori (yalnızca Shopify)", example: "Elbise" },
  { key: "sehir", label: "Şehir", example: "İstanbul" },
  { key: "ulke", label: "Ülke", example: "Türkiye" },
  { key: "imza", label: "İmza (hesaptan)", example: "Ad Soyad\nWeb Geliştirici" },
  { key: "gonderen", label: "Gönderen adı", example: "Ad Soyad" },
  {
    key: "bulgu",
    label: "Mağaza eksiği (yalnızca Shopify; boşsa gizlenir)",
    example: "Sitenizin menüsünde açılmayan bağlantılar var; ziyaretçiler bu sayfalara ulaşamıyor olabilir. Bunların çoğu mevcut temanızı değiştirmeden düzeltilebilir.",
  },
];

const TOKEN_RE = /\{\{\s*([a-z_çğıöşü0-9]+)\s*(?:\|([^}]*))?\}\}/gi;

export function renderString(
  tpl: string,
  vars: TemplateVars,
  opts: { escape?: (s: string) => string } = {},
): { output: string; missing: string[] } {
  const missing = new Set<string>();
  const output = tpl.replace(TOKEN_RE, (_, rawKey: string, fallback?: string) => {
    const key = rawKey.toLocaleLowerCase("tr");
    const value = vars[key]?.toString().trim();
    if (value) return opts.escape ? opts.escape(value) : value;
    if (fallback !== undefined) return opts.escape ? opts.escape(fallback.trim()) : fallback.trim();
    missing.add(key);
    return "";
  });
  return { output, missing: [...missing] };
}

export function usedVariables(...tpls: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const t of tpls) for (const m of (t ?? "").matchAll(TOKEN_RE)) set.add(m[1].toLocaleLowerCase("tr"));
  return [...set];
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");

/** HTML'den kaba düz metin (HTML şablonun metin alternatifi boşsa). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const plain = label.replace(/<[^>]+>/g, "").trim();
      // "info@x.com (mailto:info@x.com)" yerine yalnızca adres
      return plain === href || `mailto:${plain}` === href ? plain : `${label} (${href})`;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type EmailContent = { format: "text" | "html"; subject: string; bodyText: string; bodyHtml: string | null };
export type RenderedEmail = { subject: string; text: string; html: string | null; missing: string[] };

/** Mail altına eklenecek HTML (Ayarlar > Mail alt bilgisi). Boşsa eklenmez. */
export type RenderOptions = { footerHtml?: string | null };

const MAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Alt bilgi HTML'ini mail gövdesine eklenecek biçime getirir. `<tr>` satırı olarak yazılmış alt bilgi
 * (tablo tabanlı mail düzeni) tabloya sarılır; başka HTML olduğu gibi kalır.
 */
export function wrapFooterHtml(footer: string): string {
  const html = footer.trim();
  if (/^<(tr|tbody)[\s>]/i.test(html)) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:24px;"><tbody>${html}</tbody></table>`;
  }
  return `<div style="margin-top:24px;">${html}</div>`;
}

/** Alt bilgiyi (HTML ve düz metin olarak) mail içeriğine ekler. */
function withFooter(html: string | null, text: string, footerHtml: string | null | undefined): { html: string | null; text: string } {
  if (!footerHtml?.trim()) return { html, text };
  const footer = wrapFooterHtml(footerHtml);
  const footerText = htmlToText(footer);
  // Düz metin şablon: HTML parça, metnin birebir yansıması olur (görsel/tasarım yok), altına alt bilgi gelir
  const body = html ?? `<div style="font-family:${MAIL_FONT};font-size:14px;line-height:1.6;color:#1c1c1f;">${escapeHtml(text)}</div>`;
  const merged = /<\/body>/i.test(body) ? body.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${footer}</body>`) : body + footer;
  return { html: merged, text: footerText ? `${text}\n\n${footerText}` : text };
}

export function renderEmail(content: EmailContent, vars: TemplateVars, options: RenderOptions = {}): RenderedEmail {
  const subject = renderString(content.subject, vars);
  if (content.format === "html" && content.bodyHtml?.trim()) {
    const html = renderString(content.bodyHtml, vars, { escape: escapeHtml });
    const text = content.bodyText.trim() ? renderString(content.bodyText, vars) : { output: htmlToText(html.output), missing: [] };
    const merged = withFooter(html.output, text.output, options.footerHtml);
    return {
      subject: subject.output.replace(/\s+/g, " ").trim(),
      text: merged.text,
      html: merged.html,
      missing: [...new Set([...subject.missing, ...html.missing, ...text.missing])],
    };
  }
  const text = renderString(content.bodyText, vars);
  const plain = text.output.replace(/\n{3,}/g, "\n\n").trim();
  const merged = withFooter(null, plain, options.footerHtml);
  return {
    subject: subject.output.replace(/\s+/g, " ").trim(),
    text: merged.text,
    html: merged.html,
    missing: [...new Set([...subject.missing, ...text.missing])],
  };
}

export const DEFAULT_TEMPLATE = {
  name: "Shopify geliştirme – tanıtım",
  format: "text" as const,
  audience: "shopify" as const,
  subject: "{{marka}} için Shopify geliştirme desteği",
  bodyText: `Merhaba {{marka}} ekibi,

Shopify mağazanızda ihtiyaç duyabileceğiniz özel geliştirmeler konusunda size destek olmak isterim.

150'den fazla Shopify mağazasında edindiğim deneyimle; mevcut temalara özel section'lar ve yeni özellikler geliştiriyor, mağazalara özel Shopify uygulamaları oluşturuyorum. Ayrıca mevcut özelliklerin geliştirilmesi ve mağazaya özel ihtiyaçların karşılanması üzerine çalışıyorum.

Sıfırdan tema geliştirmek yerine, mevcut temanız üzerinden ihtiyaçlarınıza uygun çözümler sunuyorum.

İyi çalışmalar.

{{imza}}

--
Bu tür e-postaları almak istemiyorsanız "çıkar" yazarak yanıtlamanız yeterli.`,
};

/**
 * Hazır düz metin şablonları. Kurallar: kişisel ton, bağlantı yok, görsel yok, "çıkar" opt-out satırı var.
 * Mağazaya özel bulgu (eksik, hata vb.) içermezler; sadece genel, kısa tanıtım yaparlar.
 */
type StarterBody = { name: string; format: "text"; subject: string; bodyText: string; bodyHtml: null };
export type Starter = StarterBody & { audience: TemplateAudience };

export const STARTER_TEMPLATES: StarterBody[] = [
  {
    name: "Kısa tanışma",
    format: "text",
    subject: "{{site}} hakkında kısa bir not",
    bodyText: `Merhaba {{marka}} ekibi,

{{site}} sitenize baktım. Ben Shopify mağazaları üzerinde çalışan bir geliştiriciyim. Mevcut temanızı değiştirmeden ürün sayfası, filtreleme ve mobil görünüm gibi bölümlerde küçük ama işe yarar düzenlemeler yapıyorum.

Sitenizde gözüme çarpan bir şey olursa bunu size kısaca yazabilirim. Yalnızca ilginizi çekerse yanıtlamanız yeterli.

{{imza}}

--
Bu tür mesajları almak istemiyorsanız "çıkar" yazmanız yeterli.`,
    bodyHtml: null,
  },
  {
    name: "Mağaza önerisi",
    format: "text",
    subject: "{{marka}} mağazası için küçük bir öneri",
    bodyText: `Merhaba {{marka}} ekibi,

{{site}} mağazanızı inceledim. Birçok Shopify mağazasında ürün sayfası ve mobil deneyimde satışı etkileyebilecek küçük noktalar oluyor. Bunları mevcut temanız üzerinden düzeltmek, sıfırdan tema yapmaktan çok daha kısa sürer.

Mağazanız için öncelikli gördüğünüz bir konu varsa yanıtlamanız yeterli. Kısa bir değerlendirme yazıp size dönebilirim.

İyi çalışmalar.

{{imza}}

--
Bu tür mesajları almak istemiyorsanız "çıkar" yazmanız yeterli.`,
    bodyHtml: null,
  },
  {
    name: "Kısa soru",
    format: "text",
    subject: "{{site}} için kısa bir soru",
    bodyText: `Merhaba,

{{site}} için Shopify tarafında yardımcı olabileceğim bir konu olabilir. Mevcut temanızı koruyarak ihtiyaç duyduğunuz özelliği ya da düzenlemeyi yapabiliyorum.

İlgilenirseniz "evet" yazmanız yeterli, ayrıntıyı birlikte konuşalım.

{{imza}}

--
Bu tür mesajları almak istemiyorsanız "çıkar" yazmanız yeterli.`,
    bodyHtml: null,
  },
];

/**
 * Mağaza eksiğini ({{bulgu}}) kullanan şablonlar. Bulgu yoksa {{bulgu|Sitenizi inceledim.}} varsayılanı çıkar.
 * Bulgu olmayan mağazalara bunları göndermemek kullanıcının sorumluluğundadır (kampanya öncesi Mağazalar'dan filtreleyin).
 */
export const STARTER_TEMPLATES_V2: typeof STARTER_TEMPLATES = [
  {
    name: "Eksik odaklı tanışma",
    format: "text",
    subject: "{{site}} için bir not",
    bodyText: `Merhaba {{marka}} ekibi,

{{bulgu|Sitenizi inceledim.}}

Ben Shopify mağazalarında çalışan bir geliştiriciyim. Yaptığım düzenlemeler genelde mevcut temanın üzerinde kalır, bu yüzden süreç kısa sürer.

İlginizi çekerse yanıtlamanız yeterli.

{{imza}}

--
Bu tür mesajları almak istemiyorsanız "çıkar" yazmanız yeterli.`,
    bodyHtml: null,
  },
  {
    name: "Eksik odaklı kısa not",
    format: "text",
    subject: "{{site}} için tek bir öneri",
    bodyText: `Merhaba {{marka}} ekibi,

{{bulgu|Sitenizi inceledim.}}

Yanıtlamanız yeterli, ayrıntıyı kısaca paylaşabilirim.

{{imza}}

--
Bu tür mesajları almak istemiyorsanız "çıkar" yazmanız yeterli.`,
    bodyHtml: null,
  },
];

const OPT_OUT = `--
Bu tür mesajları almak istemiyorsanız "çıkar" yazmanız yeterli.`;

/**
 * Shopify dışı siteler için hazır şablonlar (F6 Faz 5). Kurallar aynı: düz metin, bağlantı yok, görsel yok,
 * "çıkar" satırı var, "Shopify" varsayımı yok. {{platform}} yalnızca yedek değerle kullanılır: platform
 * düşük güvenle tespit edildiyse değişken boş gelir ve yedek değer devreye girer.
 */
export const STARTER_TEMPLATES_V3: Starter[] = [
  {
    name: "JS siteleri – kısa tanışma",
    audience: "js",
    format: "text",
    subject: "{{site}} hakkında kısa bir not",
    bodyText: `Merhaba {{marka}} ekibi,

{{site}} sitenizin {{platform|modern bir yazılım altyapısı}} ile geliştirildiğini gördüm. Ben web sitelerine özel özellik geliştirme, performans ve mobil iyileştirmeleri ile mevcut projelerde bakım desteği veren bir yazılım geliştiriciyim.

Sitenizde ihtiyaç duyduğunuz bir geliştirme ya da düzenleme varsa kısaca anlatmanız yeterli, size nasıl yardımcı olabileceğimi yazarım.

İyi çalışmalar.

{{imza}}

${OPT_OUT}`,
    bodyHtml: null,
  },
  {
    name: "JS siteleri – kısa soru",
    audience: "js",
    format: "text",
    subject: "{{site}} için kısa bir soru",
    bodyText: `Merhaba,

{{site}} için {{platform|web}} tarafında yardımcı olabileceğim bir konu olabilir. Mevcut kod tabanınızı koruyarak yeni bir özellik, sayfa ya da performans iyileştirmesi gibi ihtiyaçlarınızda destek verebilirim.

İlgilenirseniz "evet" yazmanız yeterli, ayrıntıyı birlikte konuşalım.

{{imza}}

${OPT_OUT}`,
    bodyHtml: null,
  },
  {
    name: "WordPress – kısa tanışma",
    audience: "wordpress",
    format: "text",
    subject: "{{site}} hakkında kısa bir not",
    bodyText: `Merhaba {{marka}} ekibi,

{{site}} sitenizin WordPress ile yapıldığını gördüm. Ben WordPress siteleri üzerinde çalışan bir geliştiriciyim. Mevcut temanızı değiştirmeden özel özellik, hız iyileştirmesi ve mobil görünüm düzenlemeleri yapıyorum.

Sitenizde düzeltmek ya da eklemek istediğiniz bir şey varsa yanıtlamanız yeterli, kısaca değerlendirip size dönebilirim.

İyi çalışmalar.

{{imza}}

${OPT_OUT}`,
    bodyHtml: null,
  },
  {
    name: "Genel site – kısa tanışma",
    audience: "general",
    format: "text",
    subject: "{{site}} için kısa bir not",
    bodyText: `Merhaba {{marka}} ekibi,

{{site}} sitenize baktım. Ben web sitelerine özel özellik geliştirme, hız ve mobil görünüm iyileştirmeleri ile bakım desteği veren bir geliştiriciyim. Mevcut yapıyı değiştirmeden çalışmayı tercih ediyorum, bu yüzden süreç kısa sürüyor.

Sitenizde ihtiyaç duyduğunuz bir konu olursa yanıtlamanız yeterli.

İyi çalışmalar.

{{imza}}

${OPT_OUT}`,
    bodyHtml: null,
  },
];

const forShopify = (list: StarterBody[]): Starter[] => list.map((t) => ({ ...t, audience: "shopify" as const }));

/** Hazır şablon paketleri. Her paket bir kez eklenir (flag ayarı); kullanıcı silerse geri gelmez. */
export const STARTER_BATCHES: { flag: string; templates: Starter[] }[] = [
  { flag: "starter_templates_v1", templates: forShopify(STARTER_TEMPLATES) },
  { flag: "starter_templates_v2", templates: forShopify(STARTER_TEMPLATES_V2) },
  { flag: "starter_templates_v3_general", templates: STARTER_TEMPLATES_V3 },
];

/** HTML biçimine geçildiğinde editöre konan sade başlangıç iskeleti. */
export const HTML_STARTER = `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222; max-width: 600px;">
  <p>Merhaba {{marka}} ekibi,</p>
  <p>…</p>
  <p>İyi çalışmalar.</p>
  <p style="color:#555">{{imza}}</p>
  <p style="font-size:12px;color:#888">Bu tür e-postaları almak istemiyorsanız "çıkar" yazarak yanıtlamanız yeterli.</p>
</div>`;
