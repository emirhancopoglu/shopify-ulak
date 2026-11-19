"use server";

import { refresh } from "next/cache";
import { cleanEmail, hasMx } from "@/lib/analyzer/emails";
import { extractDomains } from "@/lib/domains";
import { parseFilters } from "@/lib/store-filters";
import {
  addManualContact,
  addStores,
  deleteContact,
  deleteStores,
  queryStoreIds,
  requeueStores,
  setBrandOverride,
  setPrimaryContact,
} from "@/lib/stores";

export type AddState = { ok: boolean; message: string } | null;

const MAX_PER_SUBMIT = 5000;

export async function addStoresAction(_prev: AddState, formData: FormData): Promise<AddState> {
  const text = String(formData.get("domains") ?? "");
  const { domains, invalid } = extractDomains(text);
  if (domains.length === 0) {
    return { ok: false, message: "Metinde geçerli bir alan adı bulunamadı." };
  }
  if (domains.length > MAX_PER_SUBMIT) {
    return { ok: false, message: `Tek seferde en fazla ${MAX_PER_SUBMIT} alan adı eklenebilir (${domains.length} bulundu).` };
  }
  const { added, duplicates } = addStores(domains, "manual");
  refresh();
  const parts = [`${added} mağaza eklendi ve analiz sırasına alındı`];
  if (duplicates) parts.push(`${duplicates} tanesi zaten listede`);
  if (invalid.length) parts.push(`${invalid.length} geçersiz satır atlandı`);
  return { ok: true, message: `${parts.join(", ")}.` };
}

/** Toplu işlemin hedefi: seçili id'ler ya da bir filtreye uyan tüm mağazalar (query string). */
export type BulkTarget = { ids: number[] } | { filter: string };

function resolveTarget(target: BulkTarget): number[] {
  if ("filter" in target && typeof target.filter === "string") {
    return queryStoreIds(parseFilters(new URLSearchParams(target.filter)));
  }
  if ("ids" in target && Array.isArray(target.ids)) {
    return target.ids.filter((x): x is number => Number.isInteger(x) && x > 0);
  }
  return [];
}

export async function reanalyzeAction(target: BulkTarget) {
  const ids = resolveTarget(target);
  requeueStores(ids);
  refresh();
  return ids.length;
}

export async function deleteAction(target: BulkTarget) {
  const ids = resolveTarget(target);
  deleteStores(ids);
  refresh();
  return ids.length;
}

export async function renameBrandAction(id: number, name: string) {
  if (!Number.isInteger(id)) return;
  setBrandOverride(id, typeof name === "string" ? name.slice(0, 120) : null);
  refresh();
}

export async function addContactAction(storeId: number, rawEmail: string, makePrimary: boolean) {
  const email = cleanEmail(String(rawEmail ?? ""));
  if (!Number.isInteger(storeId) || !email) return { ok: false, message: "Geçerli bir mail adresi girin." };
  const mx = await hasMx(email.split("@")[1]);
  addManualContact(storeId, email, mx, Boolean(makePrimary));
  refresh();
  return {
    ok: true,
    message: mx === false ? "Eklendi, ama bu alan adı mail almıyor görünüyor (MX kaydı yok)." : "Eklendi.",
  };
}

export async function setPrimaryContactAction(contactId: number) {
  if (!Number.isInteger(contactId)) return;
  setPrimaryContact(contactId);
  refresh();
}

export async function deleteContactAction(contactId: number) {
  if (!Number.isInteger(contactId)) return;
  deleteContact(contactId);
  refresh();
}
