import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Campaign, CampaignRecipient, Platform, RecipientStatus, Store, TemplateAudience } from "@/db/schema";
import { DAY_MS, getAccount, sentInLast24h, setAccountError } from "@/lib/accounts";
import { countryName } from "@/lib/format";
import { classifySendError, sendEmail } from "@/lib/mailer";
import { getEmailFooter } from "@/lib/email-footer";
import { effectivePlatform, PLATFORM_LABEL, siteKind } from "@/lib/platform-labels";
import { isSuppressed, suppress } from "@/lib/suppression";
import { AUDIENCE_LABEL, audienceAccepts } from "@/lib/template-audience";
import { renderEmail, type EmailContent, type RenderedEmail } from "@/lib/template";
import { getTemplate } from "@/lib/template-store";

const { campaigns, campaignRecipients: recipients, stores, contacts } = schema;

export const MAX_PER_HOUR = 200;
const HOUR_MS = 3600_000;
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Değişkenler
// ---------------------------------------------------------------------------

/** Mağazadan şablon değişkenleri (kampanyaya eklenirken kopyalanır). */
export function storeVars(store: Store): Record<string, string> {
  const url = store.finalUrl ? new URL(store.finalUrl).origin : `https://${store.domain}`;
  // En öncelikli mağaza eksiği; yoksa boş (şablonda {{bulgu|...}} varsayılanı kullanılır)
  const topFinding = store.findings?.[0];
  // Platform: yalnızca güvenilir tespitte dolar. Düşük güvenli ya da "bilinmiyor" ise boş kalır ve şablonun
  // yedek değeri kullanılır; böylece "X ile yazılmış siteniz" gibi yanlış bir iddia mail'e girmez.
  const platform = effectivePlatform(store);
  const isPlatformReliable = platform !== null && platform !== "unknown" && store.platformEvidence?.confidence !== "low";
  return {
    marka: (store.brandNameOverride ?? store.brandName ?? store.domain).trim(),
    site: store.domain,
    url,
    platform: isPlatformReliable ? PLATFORM_LABEL[platform] : "",
    kategori: store.category ?? "",
    sehir: store.city ?? "",
    ulke: store.country ? countryName(store.country) : "",
    bulgu: topFinding ? `${topFinding.sentence} Bunların çoğu mevcut temanızı değiştirmeden düzeltilebilir.` : "",
  };
}

// ---------------------------------------------------------------------------
// Oluşturma
// ---------------------------------------------------------------------------

export type CreateSummary = {
  id: number;
  added: number;
  skipped: { noEmail: number; noMx: number; suppressed: number; contacted: number; duplicate: number };
};

export function createCampaign(storeIds: number[], name?: string): CreateSummary {
  const skipped = { noEmail: 0, noMx: 0, suppressed: 0, contacted: 0, duplicate: 0 };
  const stamp = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date());

  return db.transaction((tx) => {
    const campaign = tx
      .insert(campaigns)
      .values({ name: name?.trim() || `Kampanya · ${stamp}` })
      .returning({ id: campaigns.id })
      .get();

    const alreadySent = new Set(
      (db.$client.prepare(`SELECT DISTINCT email FROM campaign_recipients WHERE status = 'sent'`).all() as { email: string }[]).map(
        (r) => r.email,
      ),
    );
    const seen = new Set<string>();
    let position = 0;

    for (let i = 0; i < storeIds.length; i += 500) {
      const part = storeIds.slice(i, i + 500);
      const rows = tx
        .select({ store: stores, email: contacts.email, mxValid: contacts.mxValid })
        .from(stores)
        .leftJoin(contacts, and(eq(contacts.storeId, stores.id), eq(contacts.isPrimary, true)))
        .where(inArray(stores.id, part))
        .orderBy(desc(stores.trScore), asc(stores.id))
        .all();

      for (const { store, email, mxValid } of rows) {
        if (!email) {
          skipped.noEmail++;
          continue;
        }
        if (mxValid === false) {
          skipped.noMx++;
          continue;
        }
        if (seen.has(email)) {
          skipped.duplicate++;
          continue;
        }
        if (alreadySent.has(email)) {
          skipped.contacted++;
          continue;
        }
        if (isSuppressed(email)) {
          skipped.suppressed++;
          continue;
        }
        seen.add(email);
        tx.insert(recipients)
          .values({ campaignId: campaign.id, storeId: store.id, email, vars: storeVars(store), position: position++ })
          .run();
      }
    }
    return { id: campaign.id, added: seen.size, skipped };
  });
}

// ---------------------------------------------------------------------------
// Okuma
// ---------------------------------------------------------------------------

export type CampaignCounts = Record<RecipientStatus, number> & { total: number };

function countsFor(campaignId: number): CampaignCounts {
  const rows = db.$client
    .prepare(`SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY status`)
    .all(campaignId) as { status: RecipientStatus; n: number }[];
  const c: CampaignCounts = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    c[r.status] = r.n;
    c.total += r.n;
  }
  return c;
}

export type CampaignView = Campaign & { counts: CampaignCounts; templateName: string | null; accountEmail: string | null };

function view(c: Campaign): CampaignView {
  return {
    ...c,
    counts: countsFor(c.id),
    templateName: c.templateId ? (getTemplate(c.templateId)?.name ?? null) : null,
    accountEmail: c.accountId ? (getAccount(c.accountId)?.email ?? null) : null,
  };
}

export function listCampaigns(): CampaignView[] {
  return db.select().from(campaigns).orderBy(desc(campaigns.id)).all().map(view);
}

export function getCampaign(id: number): CampaignView | null {
  const c = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  return c ? view(c) : null;
}

export const RECIPIENT_PAGE_SIZE = 100;

export function listRecipients(campaignId: number, opts: { status?: RecipientStatus; page?: number } = {}) {
  const where = and(eq(recipients.campaignId, campaignId), opts.status ? eq(recipients.status, opts.status) : undefined);
  const total = db.select({ n: sql<number>`COUNT(*)` }).from(recipients).where(where).get()?.n ?? 0;
  const page = Math.max(1, opts.page ?? 1);
  const rows = db
    .select()
    .from(recipients)
    .where(where)
    .orderBy(sql`${recipients.sentAt} IS NULL`, desc(recipients.sentAt), asc(recipients.position))
    .limit(RECIPIENT_PAGE_SIZE)
    .offset((page - 1) * RECIPIENT_PAGE_SIZE)
    .all();
  return { rows, total, page };
}

// ---------------------------------------------------------------------------
// Önizleme
// ---------------------------------------------------------------------------

/** Kampanya çalışırken kopyalanmış şablonu, taslakta güncel şablonu kullanır. */
function contentFor(c: Campaign): EmailContent | null {
  if (c.status !== "draft" && c.subject !== null && c.bodyText !== null && c.format) {
    return { format: c.format, subject: c.subject, bodyText: c.bodyText, bodyHtml: c.bodyHtml };
  }
  const t = c.templateId ? getTemplate(c.templateId) : undefined;
  return t ? { format: t.format, subject: t.subject, bodyText: t.bodyText, bodyHtml: t.bodyHtml } : null;
}

function varsFor(c: Pick<Campaign, "accountId">, r: Pick<CampaignRecipient, "vars" | "email">) {
  const account = c.accountId ? getAccount(c.accountId) : undefined;
  return { ...r.vars, email: r.email, imza: account?.signature ?? "", gonderen: account?.fromName ?? "" };
}

export function previewRecipient(campaignId: number, recipientId?: number): { recipient: CampaignRecipient; email: RenderedEmail } | null {
  const c = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  if (!c) return null;
  const content = contentFor(c);
  if (!content) return null;
  const r = recipientId
    ? db.select().from(recipients).where(and(eq(recipients.id, recipientId), eq(recipients.campaignId, campaignId))).get()
    : (db.select().from(recipients).where(and(eq(recipients.campaignId, campaignId), eq(recipients.status, "queued"))).orderBy(asc(recipients.position)).get() ??
      db.select().from(recipients).where(eq(recipients.campaignId, campaignId)).orderBy(asc(recipients.position)).get());
  if (!r) return null;
  return { recipient: r, email: renderEmail(content, varsFor(c, r), { footerHtml: getEmailFooter() }) };
}

/** Başlatmadan önce: kuyruktaki alıcılardan kaçında doldurulamayan değişken var? */
export function missingVarsReport(campaignId: number): { count: number; vars: string[] } {
  const c = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  const content = c ? contentFor(c) : null;
  if (!c || !content) return { count: 0, vars: [] };
  const rows = db.select().from(recipients).where(and(eq(recipients.campaignId, campaignId), eq(recipients.status, "queued"))).all();
  const vars = new Set<string>();
  let count = 0;
  for (const r of rows) {
    const { missing } = renderEmail(content, varsFor(c, r));
    if (missing.length) {
      count++;
      missing.forEach((m) => vars.add(m));
    }
  }
  return { count, vars: [...vars] };
}

// ---------------------------------------------------------------------------
// Şablon hedef kitlesi (F6 Faz 5)
// ---------------------------------------------------------------------------

export type AudienceMismatch = { audience: TemplateAudience; templateName: string; count: number };

/** Kuyruktaki alıcılardan şablonun hedef kitlesine uymayanların id'leri. Mağazası silinmiş alıcı sınıflanamaz, uyumlu sayılır. */
function mismatchedQueuedIds(c: Campaign): { audience: TemplateAudience; templateName: string; ids: number[] } | null {
  const template = c.templateId ? getTemplate(c.templateId) : undefined;
  if (!template) return null;
  if (template.audience === "all") return { audience: "all", templateName: template.name, ids: [] };
  const rows = db.$client
    .prepare(
      `SELECT r.id AS id, s.id AS storeId, s.platform AS platform, s.status AS status, s.source AS source
       FROM campaign_recipients r LEFT JOIN stores s ON s.id = r.store_id
       WHERE r.campaign_id = ? AND r.status = 'queued'`,
    )
    .all(c.id) as { id: number; storeId: number | null; platform: Platform | null; status: string | null; source: string | null }[];
  const ids = rows
    .filter((r) => {
      if (r.storeId === null) return false;
      const site = { platform: r.platform, status: r.status ?? "", source: r.source ?? "" };
      return !audienceAccepts(template.audience, { kind: siteKind(site), platform: effectivePlatform(site) });
    })
    .map((r) => r.id);
  return { audience: template.audience, templateName: template.name, ids };
}

/** Seçili şablonun hedef kitlesine uymayan, kuyruktaki alıcı sayısı. Şablon yoksa ya da herkese uyuyorsa null. */
export function audienceMismatchReport(campaignId: number): AudienceMismatch | null {
  const c = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  const r = c ? mismatchedQueuedIds(c) : null;
  return r && r.ids.length > 0 ? { audience: r.audience, templateName: r.templateName, count: r.ids.length } : null;
}

/** Hedef kitleye uymayan, kuyruktaki alıcıları kampanyadan çıkarır. Çıkarılan sayıyı döndürür. */
export function removeAudienceMismatches(campaignId: number): number {
  const c = requireCampaign(campaignId);
  if (c.status === "running") throw new Error("Çalışan kampanyada alıcı çıkarılamaz; önce duraklatın.");
  const r = mismatchedQueuedIds(c);
  if (!r) return 0;
  for (let i = 0; i < r.ids.length; i += 500) {
    db.delete(recipients)
      .where(and(eq(recipients.campaignId, campaignId), eq(recipients.status, "queued"), inArray(recipients.id, r.ids.slice(i, i + 500))))
      .run();
  }
  return r.ids.length;
}

// ---------------------------------------------------------------------------
// Yönetim
// ---------------------------------------------------------------------------

function requireCampaign(id: number): Campaign {
  const c = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  if (!c) throw new Error("Kampanya bulunamadı.");
  return c;
}

export function updateCampaignSettings(
  id: number,
  input: { name: string; templateId: number | null; accountId: number | null; perHour: number },
) {
  const c = requireCampaign(id);
  if (c.status === "running") throw new Error("Çalışan kampanyanın ayarları değiştirilemez; önce duraklatın.");
  db.update(campaigns)
    .set({
      name: input.name.trim() || c.name,
      templateId: input.templateId,
      accountId: input.accountId,
      perHour: Math.min(MAX_PER_HOUR, Math.max(1, Math.round(input.perHour))),
    })
    .where(eq(campaigns.id, id))
    .run();
}

/** Taslak ya da duraklatılmış kampanyayı başlatır. Şablonun o anki hali kopyalanır. */
export function startCampaign(id: number) {
  const c = requireCampaign(id);
  if (c.status === "running") return;
  if (c.status === "completed" || c.status === "stopped") throw new Error("Bitmiş kampanya yeniden başlatılamaz.");
  const template = c.templateId ? getTemplate(c.templateId) : undefined;
  if (!template) throw new Error("Önce bir şablon seçin.");
  const account = c.accountId ? getAccount(c.accountId) : undefined;
  if (!account) throw new Error("Önce gönderen hesabı seçin.");
  if (countsFor(id).queued === 0) throw new Error("Sırada gönderilecek alıcı yok.");
  // Hedef kitle koruması: Shopify tanıtım metni Next.js/WordPress sitesine (ya da tersi) gitmesin.
  const mismatch = audienceMismatchReport(id);
  if (mismatch) {
    throw new Error(
      `"${mismatch.templateName}" şablonu yalnızca "${AUDIENCE_LABEL[mismatch.audience]}" için hazırlanmış, ama kuyrukta buna uymayan ${mismatch.count} alıcı var. Şablonu değiştirin ya da uymayan alıcıları kampanyadan çıkarın.`,
    );
  }
  const sent = sentInLast24h(account.id);
  if (sent >= account.dailyLimit) throw new Error(`Bu hesabın 24 saatlik limiti dolu (${sent}/${account.dailyLimit}).`);

  db.update(campaigns)
    .set({
      status: "running",
      statusReason: null,
      format: template.format,
      subject: template.subject,
      bodyText: template.bodyText,
      bodyHtml: template.bodyHtml,
      nextSendAt: new Date(),
      startedAt: c.startedAt ?? new Date(),
    })
    .where(eq(campaigns.id, id))
    .run();
}

export function pauseCampaign(id: number, reason: string | null = null) {
  db.update(campaigns)
    .set({ status: "paused", statusReason: reason, nextSendAt: null })
    .where(and(eq(campaigns.id, id), eq(campaigns.status, "running")))
    .run();
}

export function stopCampaign(id: number) {
  db.update(campaigns)
    .set({ status: "stopped", statusReason: "Kullanıcı durdurdu.", nextSendAt: null, finishedAt: new Date() })
    .where(and(eq(campaigns.id, id), inArray(campaigns.status, ["running", "paused", "draft"])))
    .run();
}

export function deleteCampaign(id: number) {
  const c = requireCampaign(id);
  if (c.status === "running") throw new Error("Çalışan kampanya silinemez; önce durdurun.");
  db.delete(campaigns).where(eq(campaigns.id, id)).run();
}

export function removeRecipient(recipientId: number) {
  db.delete(recipients).where(and(eq(recipients.id, recipientId), eq(recipients.status, "queued"))).run();
}

export function updateRecipientVars(recipientId: number, patch: Record<string, string>) {
  const r = db.select().from(recipients).where(eq(recipients.id, recipientId)).get();
  if (!r || r.status !== "queued") throw new Error("Sadece sıradaki alıcılar düzenlenebilir.");
  db.update(recipients)
    .set({ vars: { ...r.vars, ...patch } })
    .where(eq(recipients.id, recipientId))
    .run();
}

/** Başarısız olanları (kara listeye alınmamışsa) yeniden sıraya koyar. */
export function retryFailed(campaignId: number) {
  const failed = db.select().from(recipients).where(and(eq(recipients.campaignId, campaignId), eq(recipients.status, "failed"))).all();
  const ids = failed.filter((r) => !isSuppressed(r.email)).map((r) => r.id);
  if (ids.length) {
    db.update(recipients).set({ status: "queued", attempts: 0, error: null }).where(inArray(recipients.id, ids)).run();
    const c = requireCampaign(campaignId);
    if (c.status === "completed") db.update(campaigns).set({ status: "paused", statusReason: null, finishedAt: null }).where(eq(campaigns.id, campaignId)).run();
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// Gönderim döngüsü (yalnızca worker çağırır)
// ---------------------------------------------------------------------------

/** Worker yeniden başlarsa: gönderim ortasında kalanlar tekrar denenmez (çift gönderim riskine karşı). */
export function recoverInterruptedSends() {
  return db
    .update(recipients)
    .set({ status: "failed", error: "Gönderim sırasında uygulama kapandı; gitmiş olabilir. Kontrol edip gerekirse yeniden deneyin." })
    .where(eq(recipients.status, "sending"))
    .run().changes;
}

const fmtTime = (ms: number) => new Intl.DateTimeFormat("tr-TR", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(ms);

/** Her çağrıda, zamanı gelmiş her çalışan kampanyadan en fazla bir mail gönderir. */
export async function tickCampaigns(now = Date.now(), sendFn: typeof sendEmail = sendEmail) {
  const due = db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, "running"), sql`(${campaigns.nextSendAt} IS NULL OR ${campaigns.nextSendAt} <= ${now})`))
    .all();
  const busyAccounts = new Set<number>();

  for (const c of due) {
    if (!c.accountId) {
      pauseCampaign(c.id, "Gönderen hesap seçili değil.");
      continue;
    }
    if (busyAccounts.has(c.accountId)) continue; // aynı hesaptan aynı anda tek gönderim
    busyAccounts.add(c.accountId);
    await sendNext(c, now, sendFn);
  }
}

function setNext(id: number, at: number) {
  db.update(campaigns).set({ nextSendAt: new Date(at) }).where(eq(campaigns.id, id)).run();
}

async function sendNext(c: Campaign, now: number, sendFn: typeof sendEmail) {
  const account = getAccount(c.accountId!);
  if (!account) return pauseCampaign(c.id, "Gönderen hesap bulunamadı.");

  // 24 saatlik hesap limiti (kayan pencere, tüm kampanyalar)
  if (sentInLast24h(account.id, now) >= account.dailyLimit) {
    const oldest = db.$client
      .prepare(
        `SELECT MIN(r.sent_at) AS t FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
         WHERE c.account_id = ? AND r.status = 'sent' AND r.sent_at > ?`,
      )
      .get(account.id, now - DAY_MS) as { t: number | null };
    const freeAt = (oldest.t ?? now) + DAY_MS;
    return pauseCampaign(c.id, `Günlük limit doldu (${account.dailyLimit}/24 saat). En erken ${fmtTime(freeAt)} itibarıyla devam ettirebilirsiniz.`);
  }

  // Saatlik üst sınır (aralıklar rastgele olduğu için ek güvence)
  const hourRows = db.$client
    .prepare(`SELECT sent_at AS t FROM campaign_recipients WHERE campaign_id = ? AND status = 'sent' AND sent_at > ? ORDER BY sent_at`)
    .all(c.id, now - HOUR_MS) as { t: number }[];
  if (hourRows.length >= c.perHour) return setNext(c.id, hourRows[0].t + HOUR_MS + 1000);

  const r = db
    .select()
    .from(recipients)
    .where(and(eq(recipients.campaignId, c.id), eq(recipients.status, "queued")))
    .orderBy(asc(recipients.position), asc(recipients.id))
    .get();
  if (!r) {
    db.update(campaigns).set({ status: "completed", statusReason: null, nextSendAt: null, finishedAt: new Date() }).where(eq(campaigns.id, c.id)).run();
    return;
  }

  // Son kontroller: kara liste ve başka kampanyada gönderilmiş mi
  if (isSuppressed(r.email)) {
    db.update(recipients).set({ status: "skipped", error: "Kara listede" }).where(eq(recipients.id, r.id)).run();
    return; // bir sonraki tick hemen sıradakine geçer
  }
  const sentElsewhere = db.$client
    .prepare(`SELECT 1 FROM campaign_recipients WHERE email = ? AND status = 'sent' AND campaign_id != ? LIMIT 1`)
    .get(r.email, c.id);
  if (sentElsewhere) {
    db.update(recipients).set({ status: "skipped", error: "Başka bir kampanyada zaten gönderildi" }).where(eq(recipients.id, r.id)).run();
    return;
  }

  const content: EmailContent = { format: c.format ?? "text", subject: c.subject ?? "", bodyText: c.bodyText ?? "", bodyHtml: c.bodyHtml };
  const rendered = renderEmail(content, varsFor(c, r), { footerHtml: getEmailFooter() });

  db.update(recipients)
    .set({ status: "sending", attempts: r.attempts + 1 })
    .where(eq(recipients.id, r.id))
    .run();

  try {
    const { messageId } = await sendFn(account, { to: r.email, subject: rendered.subject, text: rendered.text, html: rendered.html });
    db.update(recipients).set({ status: "sent", sentAt: new Date(), messageId, error: null }).where(eq(recipients.id, r.id)).run();
    if (account.lastError) setAccountError(account.id, null);
    if (countsFor(c.id).queued === 0) {
      // Son alıcıydı: bir sonraki aralığı beklemeden tamamla
      db.update(campaigns).set({ status: "completed", statusReason: null, nextSendAt: null, finishedAt: new Date() }).where(eq(campaigns.id, c.id)).run();
      return;
    }
    // Saatlik hedefe göre rastgele aralık: ortalama 3600/perHour sn, ±%50
    const base = HOUR_MS / c.perHour;
    setNext(c.id, Date.now() + base * (0.5 + Math.random()));
  } catch (err) {
    const { kind, message } = classifySendError(err, account.provider);
    if (kind === "auth" || kind === "quota") {
      // Alıcının suçu değil: sıraya geri koy, kampanyayı durdur
      db.update(recipients).set({ status: "queued", attempts: r.attempts, error: null }).where(eq(recipients.id, r.id)).run();
      if (kind === "auth") setAccountError(account.id, message);
      pauseCampaign(c.id, message);
    } else if (kind === "policy") {
      // İçerik/güvenlik engeli: tekrar deneme, kara listeye alma, kampanyayı durdur
      db.update(recipients).set({ status: "failed", error: message }).where(eq(recipients.id, r.id)).run();
      pauseCampaign(c.id, message);
    } else if (kind === "recipient") {
      db.update(recipients).set({ status: "failed", error: message }).where(eq(recipients.id, r.id)).run();
      suppress(r.email, "bounce", message);
      setNext(c.id, Date.now() + 5000);
    } else {
      const giveUp = r.attempts + 1 >= MAX_ATTEMPTS;
      db.update(recipients)
        .set({ status: giveUp ? "failed" : "queued", error: message })
        .where(eq(recipients.id, r.id))
        .run();
      setNext(c.id, Date.now() + 60_000);
    }
    console.error(`[send] kampanya #${c.id} → ${r.email}: ${kind}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Test gönderimi (web tarafı, şablon editöründen)
// ---------------------------------------------------------------------------

export async function sendTest(
  accountId: number,
  to: string,
  content: EmailContent,
  vars: Record<string, string>,
  opts: { prefix?: boolean } = {},
) {
  const account = getAccount(accountId);
  if (!account) throw new Error("Hesap bulunamadı.");
  const rendered = renderEmail(content, { ...vars, imza: account.signature, gonderen: account.fromName }, { footerHtml: getEmailFooter() });
  try {
    await sendEmail(account, { to, subject: opts.prefix === false ? rendered.subject : `[TEST] ${rendered.subject}`, text: rendered.text, html: rendered.html });
  } catch (err) {
    // Ham hata terminale de yazılsın (teşhis için)
    const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
    console.error(`[test-send] ${account.email} → ${to}:`, e.code ?? "", e.responseCode ?? "", e.response ?? e.message);
    throw new Error(classifySendError(err, account.provider).message);
  }
  return rendered;
}

/**
 * Tarayıcıdaki canlı önizleme için örnek mağazalar (birincil maili olanlar).
 * Her platformdan (Shopify, Next.js, WordPress…) en fazla `perGroup` tane alınır; böylece her hedef kitle için örnek bulunur.
 * `kind` ve `platform`, editörün örnekleri şablonun hedef kitlesine göre süzmesi içindir.
 */
export function sampleStoresForPreview(perGroup = 40) {
  const rows = db
    .select({ store: stores })
    .from(stores)
    .where(sql`EXISTS (SELECT 1 FROM contacts c WHERE c.store_id = stores.id AND c.is_primary = 1)`)
    .orderBy(desc(stores.trScore), desc(stores.id))
    .limit(4000)
    .all();
  const taken = new Map<string, number>();
  const out: { id: number; label: string; vars: Record<string, string>; kind: "shopify" | "general"; platform: Platform | null }[] = [];
  for (const { store } of rows) {
    const platform = effectivePlatform(store);
    const kind = siteKind(store);
    const group = platform ?? kind;
    if ((taken.get(group) ?? 0) >= perGroup) continue;
    taken.set(group, (taken.get(group) ?? 0) + 1);
    const label = [store.brandNameOverride ?? store.brandName ?? store.domain, store.domain, platform ? PLATFORM_LABEL[platform] : null].filter(Boolean).join(" · ");
    out.push({ id: store.id, label, vars: storeVars(store), kind, platform });
  }
  return out;
}
