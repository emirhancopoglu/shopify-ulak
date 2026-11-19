import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Template, TemplateFormat } from "@/db/schema";
import { DEFAULT_TEMPLATE } from "@/lib/template";

const { templates } = schema;

/** Hiç şablon yoksa kullanıcının metniyle bir başlangıç şablonu oluşturur. */
export function ensureDefaultTemplate() {
  const any = db.select({ id: templates.id }).from(templates).limit(1).get();
  if (!any) db.insert(templates).values(DEFAULT_TEMPLATE).run();
}

export function listTemplates(): Template[] {
  ensureDefaultTemplate();
  return db.select().from(templates).orderBy(desc(templates.updatedAt)).all();
}

export function getTemplate(id: number): Template | undefined {
  return db.select().from(templates).where(eq(templates.id, id)).get();
}

export type TemplateInput = {
  name: string;
  format: TemplateFormat;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
};

export function createTemplate(input: TemplateInput) {
  return db.insert(templates).values(input).returning({ id: templates.id }).get();
}

export function updateTemplate(id: number, input: TemplateInput) {
  db.update(templates)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(templates.id, id))
    .run();
}

export function duplicateTemplate(id: number) {
  const t = getTemplate(id);
  if (!t) return null;
  return createTemplate({ name: `${t.name} (kopya)`, format: t.format, subject: t.subject, bodyText: t.bodyText, bodyHtml: t.bodyHtml });
}

export function deleteTemplate(id: number) {
  db.delete(templates).where(eq(templates.id, id)).run();
}
