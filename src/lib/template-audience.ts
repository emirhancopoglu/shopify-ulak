// Client-safe: DB import yok. Şablonun hedef kitlesi ile bir sitenin uyumu (F6 Faz 5).
import type { Platform, TemplateAudience } from "@/db/schema";
import { JS_FRAMEWORK_PLATFORMS, type SiteKind } from "@/lib/platform-labels";

export const AUDIENCE_LABEL: Record<TemplateAudience, string> = {
  all: "Tüm siteler",
  shopify: "Shopify mağazaları",
  general: "Genel siteler (Shopify dışı)",
  js: "JS çerçeveleri (Next.js, React, Angular, Vue, Nuxt)",
  wordpress: "WordPress siteleri",
};

/** Kısa rozet metinleri (liste ve seçim kutuları için). */
export const AUDIENCE_SHORT_LABEL: Record<TemplateAudience, string> = {
  all: "Tümü",
  shopify: "Shopify",
  general: "Genel siteler",
  js: "JS çerçeveleri",
  wordpress: "WordPress",
};

/** Sitenin türü ve etkin platformu (siteKind / effectivePlatform sonucu). */
export type AudienceSite = { kind: SiteKind; platform: Platform | null };

/**
 * Şablon bu siteye gidebilir mi?
 * Platformu henüz bilinmeyen site (analiz bekliyor), platforma özel hedefe (js, wordpress) uymaz.
 */
export function audienceAccepts(audience: TemplateAudience, site: AudienceSite): boolean {
  switch (audience) {
    case "all":
      return true;
    case "shopify":
      return site.kind === "shopify";
    case "general":
      return site.kind === "general";
    case "js":
      return site.platform !== null && JS_FRAMEWORK_PLATFORMS.includes(site.platform);
    case "wordpress":
      return site.platform === "wordpress";
  }
}
