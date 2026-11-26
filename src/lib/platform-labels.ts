// Client-safe: DB import yok. Platformların Türkçe gösterim adları ve genel keşif seçenekleri.
import type { Platform } from "@/db/schema";

export const PLATFORM_LABEL: Record<Platform, string> = {
  shopify: "Shopify",
  nextjs: "Next.js",
  react: "React",
  angular: "Angular",
  vue: "Vue.js",
  nuxt: "Nuxt",
  wordpress: "WordPress",
  wix: "Wix",
  webflow: "Webflow",
  ticimax: "Ticimax",
  ikas: "İkas",
  ideasoft: "Ideasoft",
  unknown: "Bilinmiyor (düz HTML vb.)",
};

/** Genel siteler için seçilebilir platformlar (Shopify bu sekmede aranmaz). */
export const GENERAL_PLATFORM_CHOICES: Platform[] = ["nextjs", "react", "angular", "vue", "nuxt", "wordpress", "wix", "webflow", "ticimax", "ikas", "ideasoft", "unknown"];

/** Özel kodla yazılan JavaScript çerçeveleri (web geliştirme teklifinin ana hedefi). */
export const JS_FRAMEWORK_PLATFORMS: Platform[] = ["nextjs", "react", "angular", "vue", "nuxt"];

/** Varsayılan: web geliştirme teklifinin hedefi olan JavaScript çerçeveleri ve WordPress siteleri. */
export const DEFAULT_GENERAL_PLATFORMS: Platform[] = [...JS_FRAMEWORK_PLATFORMS, "wordpress"];

export const isGeneralPlatform = (p: string): p is Platform => (GENERAL_PLATFORM_CHOICES as string[]).includes(p);

// ---------------------------------------------------------------------------
// Tür (Shopify / Genel site) ve "etkin platform"
//
// stores.platform eski kayıtlarda boş (null): F6'dan önce analiz edilen her kayıt Shopify'dı.
// Bu yüzden tür ve etkin platform şu kuralla belirlenir. SQL karşılığı src/lib/stores.ts içindeki
// IS_SHOPIFY_SITE_SQL / EFFECTIVE_PLATFORM_SQL: ikisi birlikte değiştirilmeli.
//   Shopify: platform = shopify, YA DA platform boş + durum not_shopify değil + kaynak general_ ile başlamıyor
//   Genel:   geri kalan her şey
// ---------------------------------------------------------------------------

export type SiteKind = "shopify" | "general";

type KindInput = { platform: Platform | null; status: string; source: string };

export function siteKind(s: KindInput): SiteKind {
  if (s.platform === "shopify") return "shopify";
  if (s.platform !== null) return "general";
  return s.status !== "not_shopify" && !s.source.startsWith("general_") ? "shopify" : "general";
}

/** Tespit edilmiş platform; eski Shopify kayıtlarında (platform boş, analiz bitmiş) "shopify". Henüz bilinmiyorsa null. */
export function effectivePlatform(s: KindInput): Platform | null {
  if (s.platform !== null) return s.platform;
  return siteKind(s) === "shopify" && (s.status === "done" || s.status === "password") ? "shopify" : null;
}

export const KIND_LABEL: Record<SiteKind, string> = { shopify: "Shopify", general: "Genel siteler" };
