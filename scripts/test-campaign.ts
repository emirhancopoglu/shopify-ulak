/**
 * Gönderim motoru testi (ağa mail çıkmaz). Çalıştırma:
 *   npm run test:campaign   (scripts/test.env: DB_FILE=data/test.db, MAIL_TRANSPORT=json)
 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { db, schema, DB_PATH } from "../src/db";
import { createGmailAccount, sentInLast24h } from "../src/lib/accounts";
import { createCampaign, getCampaign, previewRecipient, startCampaign, tickCampaigns, updateCampaignSettings, retryFailed, listRecipients } from "../src/lib/campaigns";
import { isSuppressed, suppress } from "../src/lib/suppression";
import { listTemplates } from "../src/lib/template-store";

async function main() {
  assert(DB_PATH.includes("test"), "Bu test sadece DB_FILE=…test.db ile çalışır");
  assert(process.env.MAIL_TRANSPORT === "json", "MAIL_TRANSPORT=json gerekli");
  migrate(db, { migrationsFolder: "./drizzle" });
  const s = schema;

  // --- Veri: 6 mağaza
  const mk = (domain: string, brand: string | null, email: string | null, mx: boolean | null = true) => {
    const st = db.insert(s.stores).values({ domain, brandName: brand, status: "done", trScore: 60, city: "İzmir", country: "TR" }).returning().get();
    if (email) db.insert(s.contacts).values({ storeId: st.id, email, isPrimary: true, mxValid: mx }).run();
    return st.id;
  };
  const ids = [
    mk("a.com.tr", "Alfa Butik", "info@a.com.tr"),
    mk("b.com", null, "info@b.com"), // marka yok → alan adı
    mk("c.com", "Ceta", null), // mail yok
    mk("d.com", "Delta", "info@d.com", false), // MX yok
    mk("e.com", "Epsilon", "info@e.com"),
    mk("f.com", "Fi", "info@a.com.tr"), // aynı mail (tekrar)
  ];
  suppress("info@e.com", "manual");

  const sum = createCampaign(ids);
  console.log("oluşturma özeti:", sum);
  assert.equal(sum.added, 2);
  assert.deepEqual(sum.skipped, { noEmail: 1, noMx: 1, suppressed: 1, contacted: 0, duplicate: 1 });

  // --- Ayarlar ve başlatma doğrulamaları
  assert.throws(() => startCampaign(sum.id), /şablon/);
  const tpl = listTemplates()[0]; // varsayılan şablon otomatik oluşur
  const acc = await createGmailAccount({ email: "ben@gmail.com", fromName: "Ad Soyad", password: "abcd efgh ijkl mnop", dailyLimit: 3, signature: "Ad Soyad\nShopify Geliştirici\nhttps://portfolyo.dev" });
  updateCampaignSettings(sum.id, { name: "Test", templateId: tpl.id, accountId: acc.id, perHour: 200 });

  const pv = previewRecipient(sum.id)!;
  console.log("\n--- önizleme ---\nKonu:", pv.email.subject, "\n" + pv.email.text, "\neksik:", pv.email.missing);
  assert.match(pv.email.subject, /Alfa Butik/);
  assert.match(pv.email.text, /Merhaba Alfa Butik ekibi/);
  assert.match(pv.email.text, /Shopify Geliştirici/);

  startCampaign(sum.id);
  assert.equal(getCampaign(sum.id)!.status, "running");

  // --- 1. tick: bir mail gider, sıradaki zaman ileri atılır
  await tickCampaigns();
  let c = getCampaign(sum.id)!;
  assert.equal(c.counts.sent, 1);
  const gap = c.nextSendAt!.getTime() - Date.now();
  console.log(`\nsonraki gönderim ~${Math.round(gap / 1000)} sn sonra (200/saat → ort. 18 sn, ±%50)`);
  assert(gap > 8_000 && gap < 28_000);

  // Zamanı gelmeden tick: gönderim olmamalı
  await tickCampaigns();
  assert.equal(getCampaign(sum.id)!.counts.sent, 1);

  // Zamanı ileri al → 2. mail, sonra kuyruk boş → tamamlandı
  await tickCampaigns(Date.now() + 60_000);
  await tickCampaigns(Date.now() + 120_000);
  c = getCampaign(sum.id)!;
  assert.equal(c.counts.sent, 2);
  assert.equal(c.status, "completed");
  const b = listRecipients(sum.id).rows.find((r) => r.email === "info@b.com")!;
  assert.equal(b.vars.marka, "b.com");

  // --- Daha önce gönderilenler yeni kampanyada elenir
  const sum2 = createCampaign(ids);
  assert.equal(sum2.added, 0);
  assert.equal(sum2.skipped.contacted, 3); // a ve b gönderildi; f.com da a ile aynı adresi kullanıyor
  console.log("\n2. kampanya özeti:", sum2.skipped);

  // --- Günlük limit: limit 3, 2 gönderildi. 3 yeni alıcı → 1 gönderip duraklamalı
  const more = ["x1.com", "x2.com", "x3.com"].map((d, i) => mk(d, `X${i}`, `info@${d}`));
  const sum3 = createCampaign(more);
  updateCampaignSettings(sum3.id, { name: "Limit testi", templateId: tpl.id, accountId: acc.id, perHour: 200 });
  startCampaign(sum3.id);
  for (let i = 1; i <= 3; i++) await tickCampaigns(Date.now() + i * 60_000);
  c = getCampaign(sum3.id)!;
  console.log("\nlimit testi:", c.status, "|", c.statusReason, "| 24s gönderim:", sentInLast24h(acc.id));
  assert.equal(c.counts.sent, 1);
  assert.equal(c.status, "paused");
  assert.match(c.statusReason!, /Günlük limit doldu/);
  assert.throws(() => startCampaign(sum3.id), /limiti dolu/);

  // --- Kesintiden kurtarma
  db.update(s.campaignRecipients).set({ status: "sending" }).where(eq(s.campaignRecipients.email, "info@x2.com")).run();
  const { recoverInterruptedSends } = await import("../src/lib/campaigns");
  assert.equal(recoverInterruptedSends(), 1);
  assert.equal(retryFailed(sum3.id), 1);

  // --- Outlook: hesap ekleme/yeniden bağlama, gönderim (kuru mod), hata sınıflandırma
  const { upsertOutlookAccount } = await import("../src/lib/accounts");
  const { classifySendError } = await import("../src/lib/mailer");
  const { explainMicrosoftError, OutlookAuthError } = await import("../src/lib/outlook");
  const o1 = upsertOutlookAccount({ email: "Ben@Outlook.com", name: "Ad Soyad", refreshToken: "rt-1" });
  const o2 = upsertOutlookAccount({ email: "ben@outlook.com", refreshToken: "rt-2" });
  assert.equal(o1.created, true);
  assert.equal(o2.created, false); // aynı adres → yeniden bağlama, yeni hesap değil
  assert.equal(o1.id, o2.id);
  const oacc = db.select().from(s.accounts).where(eq(s.accounts.id, o1.id)).get()!;
  assert.equal(oacc.dailyLimit, 150);
  assert.equal(oacc.fromName, "Ad Soyad");
  const sumO = createCampaign([mk("o1.com", "Oscar", "info@o1.com")]);
  updateCampaignSettings(sumO.id, { name: "Outlook", templateId: tpl.id, accountId: o1.id, perHour: 20 });
  startCampaign(sumO.id);
  await tickCampaigns();
  assert.equal(getCampaign(sumO.id)!.status, "completed");

  const cls = (e: object) => classifySendError(e, "outlook").kind;
  assert.equal(cls({ responseCode: 554, response: "554 5.2.0 STOREDRV.Submission.Exception:OutboundSpamException; Failed to process message" }), "quota");
  assert.equal(cls({ code: "EAUTH", responseCode: 535, response: "535 5.7.3 Authentication unsuccessful" }), "auth");
  assert.equal(cls(new OutlookAuthError("x")), "auth");
  assert.equal(cls({ responseCode: 550, command: "RCPT TO", response: "550 5.1.1 User unknown" }), "recipient");
  assert.equal(cls({ code: "ETIMEDOUT", message: "timeout" }), "transient");
  assert.match(explainMicrosoftError("invalid_client", "AADSTS7000218: The request body must contain client_assertion"), /Mobile and desktop/);
  assert.match(explainMicrosoftError("invalid_request", "AADSTS50011: The redirect URI does not match"), /birebir/);
  assert.match(explainMicrosoftError("invalid_grant", "AADSTS7000012: The grant was obtained for a different tenant. Trace ID: x"), /tamamlanamadı: AADSTS7000012/);
  console.log("outlook kontrolleri geçti");

  // --- Kurumsal SMTP: ekleme, şifre sızıntısı yok, düzenleme, gönderim (kuru mod), hata sınıflandırma
  const { createSmtpAccount, listAccounts, updateAccount } = await import("../src/lib/accounts");
  const { decodeSmtpSecret } = await import("../src/lib/mailer");
  const sm = await createSmtpAccount({
    email: "info@firma.com.tr",
    fromName: "Firma",
    dailyLimit: 100,
    signature: "",
    host: "mail.firma.com.tr",
    port: 465,
    secure: true,
    user: "info@firma.com.tr",
    password: "Gizli Şifre 1!",
  });
  const smRow = db.select().from(s.accounts).where(eq(s.accounts.id, sm.id)).get()!;
  assert.equal(smRow.provider, "smtp");
  assert(!smRow.secret.includes("Gizli"), "şifre düz metin saklanmamalı");
  assert.equal(decodeSmtpSecret(smRow.secret).password, "Gizli Şifre 1!"); // boşluklar korunur
  const smView = listAccounts().find((a) => a.id === sm.id)!;
  assert.deepEqual(smView.smtp, { host: "mail.firma.com.tr", port: 465, secure: true, user: "info@firma.com.tr" });
  assert(!JSON.stringify(smView).includes("Gizli"), "arayüz görünümünde şifre olmamalı");
  await updateAccount(sm.id, { fromName: "Firma Ekibi", dailyLimit: 80, signature: "", smtp: { host: "smtp.firma.com.tr", port: 587, secure: false, user: "info@firma.com.tr" } });
  const smAfter = decodeSmtpSecret(db.select().from(s.accounts).where(eq(s.accounts.id, sm.id)).get()!.secret);
  assert.deepEqual([smAfter.host, smAfter.port, smAfter.secure, smAfter.password], ["smtp.firma.com.tr", 587, false, "Gizli Şifre 1!"]); // şifre boş bırakılınca korunur
  const sumS = createCampaign([mk("s1.com", "Sera", "info@s1.com")]);
  updateCampaignSettings(sumS.id, { name: "Kurumsal", templateId: tpl.id, accountId: sm.id, perHour: 20 });
  startCampaign(sumS.id);
  await tickCampaigns();
  assert.equal(getCampaign(sumS.id)!.status, "completed");
  const cs = (e: object) => classifySendError(e, "smtp").kind;
  assert.equal(cs({ code: "EAUTH", responseCode: 535, response: "535 Incorrect authentication data" }), "auth");
  assert.equal(cs({ responseCode: 553, command: "MAIL FROM", response: "553 Sender address rejected: not owned by user" }), "auth");
  assert.equal(cs({ responseCode: 550, command: "RCPT TO", response: "550 No such user" }), "recipient");
  assert.equal(cs({ responseCode: 550, response: "550 Too many emails sent. Hourly limit exceeded" }), "quota");
  assert.equal(cs({ responseCode: 550, command: "DATA", response: "550 5.7.1 This message is blocked due to security reason" }), "policy");
  assert.equal(cs({ responseCode: 554, response: "554 5.7.1 Message rejected as spam" }), "policy");
  assert.equal(cs({ code: "ETIMEDOUT", message: "timeout" }), "transient");
  console.log("kurumsal smtp kontrolleri geçti");

  // --- Policy (550 5.7.1 DATA) davranışı: tekrar deneme yok, kara liste yok, kampanya duraklar
  const sumP = createCampaign([mk("p1.com", "P1", "info@p1.com"), mk("p2.com", "P2", "info@p2.com")]);
  updateCampaignSettings(sumP.id, { name: "Policy testi", templateId: tpl.id, accountId: sm.id, perHour: 20 });
  startCampaign(sumP.id);
  let sendCalls = 0;
  const failWithPolicy = async () => {
    sendCalls++;
    throw Object.assign(new Error("Message failed: 550 5.7.1 This message is blocked due to security reason"), {
      responseCode: 550,
      command: "DATA",
      response: "550 5.7.1 This message is blocked due to security reason",
    });
  };
  await tickCampaigns(Date.now(), failWithPolicy);
  await tickCampaigns(Date.now() + 120_000, failWithPolicy); // durakladığı için tekrar çalışmamalı
  const cp = getCampaign(sumP.id)!;
  assert.equal(sendCalls, 1);
  assert.equal(cp.status, "paused");
  assert.match(cp.statusReason!, /güvenlik\/içerik politikası/);
  const pRows = listRecipients(sumP.id).rows;
  const p1 = pRows.find((r) => r.email === "info@p1.com")!;
  const p2 = pRows.find((r) => r.email === "info@p2.com")!;
  assert.equal(p1.status, "failed");
  assert.equal(p1.attempts, 1);
  assert.equal(p2.status, "queued");
  assert.equal(isSuppressed("info@p1.com"), false);
  console.log("policy kontrolleri geçti");

  console.log("\n✓ tüm kontroller geçti");
}

main().finally(() => {
  db.$client.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});
