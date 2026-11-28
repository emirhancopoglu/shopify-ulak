/** Tarayıcıda da kullanılır; veritabanı import'u içermemeli. */
import type { CampaignStatus, RecipientStatus } from "@/db/schema";

/** Kampanya başına kayan bir saatte izin verilen en yüksek gönderim. */
export const MAX_PER_HOUR = 400;

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; cls: string }> = {
  draft: { label: "Taslak", cls: "bg-stone-100 text-stone-700" },
  running: { label: "Gönderiliyor", cls: "bg-emerald-600 text-white" },
  paused: { label: "Duraklatıldı", cls: "bg-amber-100 text-amber-900" },
  completed: { label: "Tamamlandı", cls: "bg-stone-800 text-white" },
  stopped: { label: "Durduruldu", cls: "bg-red-100 text-red-800" },
};

export const RECIPIENT_STATUS: Record<RecipientStatus, { label: string; cls: string }> = {
  queued: { label: "Sırada", cls: "text-stone-500" },
  sending: { label: "Gönderiliyor", cls: "text-amber-700" },
  sent: { label: "Gönderildi", cls: "text-emerald-700" },
  failed: { label: "Başarısız", cls: "text-red-700" },
  skipped: { label: "Atlandı", cls: "text-stone-400" },
};
