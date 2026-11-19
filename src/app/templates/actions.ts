"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { TEMPLATE_FORMATS, type TemplateFormat } from "@/db/schema";
import type { FormState } from "@/components/ui";
import { cleanEmail } from "@/lib/analyzer/emails";
import { sendTest } from "@/lib/campaigns";
import { createTemplate, deleteTemplate, duplicateTemplate, updateTemplate, type TemplateInput } from "@/lib/template-store";

function validate(raw: TemplateInput): TemplateInput | string {
  const format = (TEMPLATE_FORMATS as readonly string[]).includes(raw.format) ? (raw.format as TemplateFormat) : "text";
  const input: TemplateInput = {
    name: String(raw.name ?? "").trim().slice(0, 120),
    format,
    subject: String(raw.subject ?? "").trim().slice(0, 300),
    bodyText: String(raw.bodyText ?? ""),
    bodyHtml: raw.bodyHtml === null ? null : String(raw.bodyHtml ?? ""),
  };
  if (!input.name) return "Şablon adı gerekli.";
  if (!input.subject) return "Konu satırı gerekli.";
  if (format === "text" && !input.bodyText.trim()) return "Mail metni boş olamaz.";
  if (format === "html" && !input.bodyHtml?.trim()) return "HTML gövde boş olamaz.";
  return input;
}

export async function createTemplateAction() {
  const { id } = createTemplate({ name: "Yeni şablon", format: "text", subject: "{{marka}} hakkında", bodyText: "Merhaba {{marka}} ekibi,\n\n\n\nİyi çalışmalar.\n\n{{imza}}", bodyHtml: null });
  redirect(`/templates/${id}`);
}

export async function saveTemplateAction(id: number, raw: TemplateInput): Promise<FormState> {
  if (!Number.isInteger(id)) return { ok: false, message: "Geçersiz şablon." };
  const input = validate(raw);
  if (typeof input === "string") return { ok: false, message: input };
  updateTemplate(id, input);
  refresh();
  return { ok: true, message: "Kaydedildi." };
}

export async function duplicateTemplateAction(id: number) {
  const r = duplicateTemplate(id);
  if (r) redirect(`/templates/${r.id}`);
}

export async function deleteTemplateAction(id: number) {
  if (!Number.isInteger(id)) return;
  deleteTemplate(id);
  redirect("/templates");
}

export async function sendTestAction(
  raw: TemplateInput,
  accountId: number,
  to: string,
  vars: Record<string, string>,
  prefix: boolean = true,
): Promise<FormState> {
  const input = validate(raw);
  if (typeof input === "string") return { ok: false, message: input };
  const email = cleanEmail(String(to ?? ""));
  if (!email) return { ok: false, message: "Geçerli bir alıcı adresi girin." };
  if (!Number.isInteger(accountId)) return { ok: false, message: "Gönderen hesap seçin." };
  const safeVars = Object.fromEntries(Object.entries(vars ?? {}).map(([k, v]) => [String(k), String(v ?? "")]));
  try {
    await sendTest(accountId, email, input, safeVars, { prefix: prefix !== false });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, message: `Test maili ${email} adresine gönderildi. Gelen kutusunu ve spam klasörünü kontrol edin.` };
}
