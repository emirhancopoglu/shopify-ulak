/**
 * Şablon motoru. Sözdizimi:
 *   {{marka}}            → değişken
 *   {{marka|merhaba}}    → değişken boşsa "merhaba"
 * Hem sunucu hem tarayıcıda çalışır (canlı önizleme); bağımlılık içermez.
 */

export type TemplateVars = Record<string, string | null | undefined>;

export const VARIABLES: { key: string; label: string; example: string }[] = [
  { key: "marka", label: "Marka adı", example: "Ornek Butik" },
  { key: "site", label: "Alan adı", example: "ornekbutik.com" },
  { key: "url", label: "Site adresi", example: "https://ornekbutik.com" },
  { key: "kategori", label: "Ana kategori", example: "Elbise" },
  { key: "sehir", label: "Şehir", example: "İstanbul" },
  { key: "ulke", label: "Ülke", example: "Türkiye" },
  { key: "imza", label: "İmza (hesaptan)", example: "Ad Soyad\nShopify Geliştirici" },
  { key: "gonderen", label: "Gönderen adı", example: "Ad Soyad" },
  {
    key: "bulgu",
    label: "Mağaza eksiği (boşsa gizlenir)",
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
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) =>
      label.replace(/<[^>]+>/g, "").trim() === href ? href : `${label} (${href})`,
    )
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

export function renderEmail(content: EmailContent, vars: TemplateVars): RenderedEmail {
  const subject = renderString(content.subject, vars);
  if (content.format === "html" && content.bodyHtml?.trim()) {
    const html = renderString(content.bodyHtml, vars, { escape: escapeHtml });
    const text = content.bodyText.trim() ? renderString(content.bodyText, vars) : { output: htmlToText(html.output), missing: [] };
    return {
      subject: subject.output.replace(/\s+/g, " ").trim(),
      text: text.output,
      html: html.output,
      missing: [...new Set([...subject.missing, ...html.missing, ...text.missing])],
    };
  }
  const text = renderString(content.bodyText, vars);
  return {
    subject: subject.output.replace(/\s+/g, " ").trim(),
    text: text.output.replace(/\n{3,}/g, "\n\n").trim(),
    html: null,
    missing: [...new Set([...subject.missing, ...text.missing])],
  };
}

export const DEFAULT_TEMPLATE = {
  name: "Shopify geliştirme – tanıtım",
  format: "text" as const,
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
export const STARTER_TEMPLATES: { name: string; format: "text"; subject: string; bodyText: string; bodyHtml: null }[] = [
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

/** Hazır şablon paketleri. Her paket bir kez eklenir (flag ayarı); kullanıcı silerse geri gelmez. */
export const STARTER_BATCHES: { flag: string; templates: typeof STARTER_TEMPLATES }[] = [
  { flag: "starter_templates_v1", templates: STARTER_TEMPLATES },
  { flag: "starter_templates_v2", templates: STARTER_TEMPLATES_V2 },
];

/** HTML biçimine geçildiğinde editöre konan sade başlangıç iskeleti. */
export const HTML_STARTER = `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222; max-width: 600px;">
  <p>Merhaba {{marka}} ekibi,</p>
  <p>…</p>
  <p>İyi çalışmalar.</p>
  <p style="color:#555">{{imza}}</p>
  <p style="font-size:12px;color:#888">Bu tür e-postaları almak istemiyorsanız "çıkar" yazarak yanıtlamanız yeterli.</p>
</div>`;
