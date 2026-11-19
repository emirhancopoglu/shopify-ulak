import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ui } from "@/components/ui";
import { listAccounts } from "@/lib/accounts";
import { sampleStoresForPreview } from "@/lib/campaigns";
import { getTemplate } from "@/lib/template-store";
import { TemplateEditor } from "./template-editor";

export default function TemplatePage({ params }: PageProps<"/templates/[id]">) {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <Link href="/templates" className="text-stone-500 hover:text-stone-900">
        ← Şablonlar
      </Link>
      <Suspense fallback={<div className={`${ui.card} h-[70vh] animate-pulse`} />}>
        <EditorLoader params={params} />
      </Suspense>
    </div>
  );
}

async function EditorLoader({ params }: { params: PageProps<"/templates/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const template = getTemplate(Number(id));
  if (!template) notFound();
  const accounts = listAccounts().map((a) => ({ id: a.id, email: a.email, fromName: a.fromName, signature: a.signature }));
  return <TemplateEditor template={template} accounts={accounts} samples={sampleStoresForPreview()} />;
}
