"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/ui";
import { MAX_PER_HOUR } from "@/lib/campaign-labels";
import {
  createCampaign,
  deleteCampaign,
  pauseCampaign,
  removeAudienceMismatches,
  removeRecipient,
  retryFailed,
  startCampaign,
  stopCampaign,
  updateCampaignSettings,
  updateRecipientVars,
} from "@/lib/campaigns";
import { parseFilters } from "@/lib/store-filters";
import { queryStoreIds } from "@/lib/stores";

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isId = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

/** Mağazalar sayfasındaki seçimden kampanya taslağı oluşturur ve detayına yönlendirir. */
export async function createCampaignAction(target: { ids: number[] } | { filter: string }) {
  const ids =
    "filter" in target && typeof target.filter === "string"
      ? queryStoreIds(parseFilters(new URLSearchParams(target.filter)))
      : "ids" in target && Array.isArray(target.ids)
        ? target.ids.filter(isId)
        : [];
  if (ids.length === 0) return;
  const summary = createCampaign(ids);
  const s = summary.skipped;
  const qs = new URLSearchParams({
    created: String(summary.added),
    ...(s.noEmail ? { noEmail: String(s.noEmail) } : {}),
    ...(s.noMx ? { noMx: String(s.noMx) } : {}),
    ...(s.suppressed ? { suppressed: String(s.suppressed) } : {}),
    ...(s.contacted ? { contacted: String(s.contacted) } : {}),
    ...(s.duplicate ? { duplicate: String(s.duplicate) } : {}),
  });
  redirect(`/campaigns/${summary.id}?${qs}`);
}

export async function saveCampaignSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = Number(fd.get("id"));
  const templateId = Number(fd.get("templateId")) || null;
  const accountId = Number(fd.get("accountId")) || null;
  const perHour = Number(fd.get("perHour"));
  if (!isId(id)) return { ok: false, message: "Geçersiz kampanya." };
  if (!Number.isFinite(perHour) || perHour < 1 || perHour > MAX_PER_HOUR) {
    return { ok: false, message: `Saatlik adet 1 ile ${MAX_PER_HOUR} arasında olmalı.` };
  }
  try {
    updateCampaignSettings(id, { name: String(fd.get("name") ?? ""), templateId, accountId, perHour });
  } catch (err) {
    return { ok: false, message: errMsg(err) };
  }
  refresh();
  return { ok: true, message: "Kaydedildi." };
}

export async function startCampaignAction(id: number): Promise<FormState> {
  if (!isId(id)) return { ok: false, message: "Geçersiz kampanya." };
  try {
    startCampaign(id);
  } catch (err) {
    return { ok: false, message: errMsg(err) };
  }
  refresh();
  return { ok: true, message: "Gönderim başladı." };
}

export async function pauseCampaignAction(id: number) {
  if (!isId(id)) return;
  pauseCampaign(id, "Kullanıcı duraklattı.");
  refresh();
}

export async function stopCampaignAction(id: number) {
  if (!isId(id)) return;
  stopCampaign(id);
  refresh();
}

export async function deleteCampaignAction(id: number): Promise<FormState> {
  if (!isId(id)) return { ok: false, message: "Geçersiz kampanya." };
  try {
    deleteCampaign(id);
  } catch (err) {
    return { ok: false, message: errMsg(err) };
  }
  redirect("/campaigns");
}

export async function retryFailedAction(id: number) {
  if (!isId(id)) return 0;
  const n = retryFailed(id);
  refresh();
  return n;
}

export async function removeRecipientAction(recipientId: number) {
  if (!isId(recipientId)) return;
  removeRecipient(recipientId);
  refresh();
}

/** Şablonun hedef kitlesine uymayan, kuyruktaki alıcıları kampanyadan çıkarır. */
export async function removeAudienceMismatchesAction(id: number): Promise<FormState> {
  if (!isId(id)) return { ok: false, message: "Geçersiz kampanya." };
  let removed = 0;
  try {
    removed = removeAudienceMismatches(id);
  } catch (err) {
    return { ok: false, message: errMsg(err) };
  }
  refresh();
  return { ok: true, message: `${removed} alıcı çıkarıldı.` };
}

export async function updateRecipientBrandAction(recipientId: number, marka: string): Promise<FormState> {
  if (!isId(recipientId) || typeof marka !== "string" || !marka.trim()) return { ok: false, message: "Marka adı boş olamaz." };
  try {
    updateRecipientVars(recipientId, { marka: marka.trim().slice(0, 120) });
  } catch (err) {
    return { ok: false, message: errMsg(err) };
  }
  refresh();
  return { ok: true, message: "Güncellendi." };
}
