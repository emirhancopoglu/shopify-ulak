/**
 * Gönderim motoru testi (ağa mail çıkmaz). Çalıştırma:
 *   npm run test:campaign   (scripts/test.env: DB_FILE=data/test.db, MAIL_TRANSPORT=json)
 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { db, schema, DB_PATH } from "../src/db";
import { createGmailAccount, getAccount, sentInLast24h } from "../src/lib/accounts";
import { createCampaign, getCampaign, previewRecipient, startCampaign, storeVars, tickCampaigns, updateCampaignSettings, retryFailed, listRecipients } from "../src/lib/campaigns";
import { queryStores } from "../src/lib/stores";
import { DEFAULT_FILTERS, parseFilters, serializeFilters, type StoreFilters } from "../src/lib/store-filters";
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
  const tpl = listTemplates().find((t) => t.name === "Shopify geliştirme – tanıtım")!; // varsayılan şablon otomatik oluşur
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

  // --- Gönderilenler kopyası (IMAP APPEND): kuru modda enjekte edilen fonksiyonla akış doğrulanır
  const { sendEmail, imapSettingsFor, decodeSmtpSecret: decodeSmtp } = await import("../src/lib/mailer");
  const smAccount = getAccount(sm.id)!;
  const appended: { host: string; port: number; raw: string }[] = [];
  const res = await sendEmail(
    smAccount,
    { to: "alici@ornek.com", subject: "IMAP kopya testi", text: "Merhaba", html: null },
    { appendSent: async (cfg, raw) => void appended.push({ host: cfg.host, port: cfg.port, raw: raw.toString("utf8") }) },
  );
  assert.equal(appended.length, 1, "SMTP gönderimi sonrası tam bir kopya eklenmeli");
  assert.match(appended[0].raw, /^Subject: IMAP kopya testi/m, "kopya ham MIME içermeli");
  assert.ok(appended[0].raw.includes(res.messageId), "kopyanın Message-ID'si gönderilenle aynı olmalı");
  assert.match(appended[0].raw, /\r\n/, "IMAP kopyası CRLF satır sonu kullanmalı");
  assert.equal(appended[0].host, "smtp.firma.com.tr");

  // Kopya hatası gönderimi bozmamalı
  const res2 = await sendEmail(
    smAccount,
    { to: "alici2@ornek.com", subject: "Kopya hatası", text: "x", html: null },
    { appendSent: async () => { throw new Error("IMAP bağlantısı reddedildi"); } },
  );
  assert.ok(res2.messageId, "kopya hatasında gönderim yine başarılı dönmeli");

  // Kopya kapalıyken (appendSent: null) gönderim normal tamamlanmalı
  await sendEmail(smAccount, { to: "alici3@ornek.com", subject: "x", text: "x", html: null }, { appendSent: null });

  // Gmail hesabında kopya eklenmez (Gmail SMTP kendisi kaydeder)
  let gmailAppends = 0;
  await sendEmail(getAccount(acc.id)!, { to: "alici4@ornek.com", subject: "gmail", text: "x", html: null }, { appendSent: async () => void gmailAppends++ });
  assert.equal(gmailAppends, 0, "gmail için IMAP kopyası eklenmemeli");

  // IMAP ayarı: yoksa SMTP host + 993/SSL, varsa saklanan değer
  const decodedNoImap = decodeSmtp(smAccount.secret);
  assert.deepEqual(imapSettingsFor(decodedNoImap), { host: "smtp.firma.com.tr", port: 993, secure: true });
  assert.deepEqual(imapSettingsFor({ ...decodedNoImap, imap: { host: "imap.firma.com.tr", port: 143, secure: false } }), { host: "imap.firma.com.tr", port: 143, secure: false });
  console.log("gönderilenler kopyası kontrolleri geçti");

  // --- Hazır şablonlar: her biri render edilir, eksik değişken yok, opt-out var, bağlantı yok
  const { STARTER_BATCHES, renderEmail: render } = await import("../src/lib/template");
  const { ensureStarterTemplates } = await import("../src/lib/template-store");
  const allStarters = STARTER_BATCHES.flatMap((b) => b.templates);
  const sample = { marka: "Ornek Butik", site: "ornekbutik.com", imza: "Ad Soyad\nShopify Geliştirici", bulgu: "Sitenizin menüsünde açılmayan bağlantılar var." };
  for (const st of allStarters) {
    const out = render({ format: "text", subject: st.subject, bodyText: st.bodyText, bodyHtml: null }, sample);
    assert.deepEqual(out.missing, [], `${st.name}: eksik değişken`);
    assert.ok(out.subject.length > 0 && out.subject.length <= 70, `${st.name}: konu uzunluğu`);
    assert.match(out.text, /"çıkar" yazmanız yeterli/, `${st.name}: opt-out satırı yok`);
    assert.doesNotMatch(out.text + out.subject, /https?:\/\/|www\./i, `${st.name}: bağlantı içermemeli`);
  }
  // Bulgu yoksa varsayılan cümle kullanılır, eksik değişken sayılmaz
  const noFinding = render(
    { format: "text", subject: allStarters[3].subject, bodyText: allStarters[3].bodyText, bodyHtml: null },
    { ...sample, bulgu: "" },
  );
  assert.deepEqual(noFinding.missing, []);
  assert.match(noFinding.text, /Sitenizi inceledim\./);
  assert.match(render({ format: "text", subject: "x", bodyText: "{{bulgu|Sitenizi inceledim.}}", bodyHtml: null }, sample).text, /menüsünde açılmayan/);

  const names = listTemplates().map((t) => t.name);
  for (const st of allStarters) assert.equal(names.filter((n) => n === st.name).length, 1, `${st.name}: bir kez eklenmeli`);
  assert.ok(names.includes("Eksik odaklı tanışma"), "bulgu şablonları eklenmeli");
  // Kullanıcı silince tekrar eklenmemeli
  const { deleteTemplate } = await import("../src/lib/template-store");
  const kisa = listTemplates().find((t) => t.name === "Kısa tanışma")!;
  deleteTemplate(kisa.id);
  ensureStarterTemplates();
  assert.equal(listTemplates().filter((t) => t.name === "Kısa tanışma").length, 0, "silinen hazır şablon geri gelmemeli");
  console.log("hazır şablon kontrolleri geçti");

  // --- F6 Faz 5: genel site şablonları (platform değişkeni, Shopify'a özgü metin yok)
  const v3 = STARTER_BATCHES.find((b) => b.flag === "starter_templates_v3_general")!.templates;
  assert.equal(v3.length, 4);
  for (const st of v3) {
    assert.notEqual(st.audience, "shopify", `${st.name}: genel şablon Shopify hedefli olamaz`);
    assert.doesNotMatch(`${st.subject} ${st.bodyText}`, /shopify/i, `${st.name}: Shopify geçmemeli`);
    assert.doesNotMatch(st.bodyText, /\{\{\s*(bulgu|kategori)/, `${st.name}: Shopify'a özgü değişken kullanmamalı`);
    // platform boşken yedek değer devreye girmeli, eksik değişken kalmamalı
    const out = render({ format: "text", subject: st.subject, bodyText: st.bodyText, bodyHtml: null }, { marka: "Ornek", site: "ornek.com", imza: "Ad Soyad", platform: "" });
    assert.deepEqual(out.missing, [], `${st.name}: platform boşken eksik değişken`);
    const withPlatform = render({ format: "text", subject: st.subject, bodyText: st.bodyText, bodyHtml: null }, { marka: "Ornek", site: "ornek.com", imza: "Ad Soyad", platform: "Next.js" });
    assert.equal(withPlatform.missing.length, 0);
  }
  // Mevcut (Shopify) şablonların tamamı Shopify hedefli olmalı
  for (const b of STARTER_BATCHES.filter((x) => x.flag !== "starter_templates_v3_general")) for (const st of b.templates) assert.equal(st.audience, "shopify");
  const { audienceAccepts } = await import("../src/lib/template-audience");
  assert.equal(audienceAccepts("all", { kind: "general", platform: null }), true);
  assert.equal(audienceAccepts("shopify", { kind: "shopify", platform: "shopify" }), true);
  assert.equal(audienceAccepts("shopify", { kind: "general", platform: "nextjs" }), false);
  assert.equal(audienceAccepts("general", { kind: "general", platform: null }), true);
  assert.equal(audienceAccepts("js", { kind: "general", platform: "nuxt" }), true);
  assert.equal(audienceAccepts("js", { kind: "general", platform: "wordpress" }), false);
  assert.equal(audienceAccepts("js", { kind: "general", platform: null }), false, "platformu bilinmeyen site platforma özel şablona gitmez");
  assert.equal(audienceAccepts("wordpress", { kind: "general", platform: "wordpress" }), true);

  // storeVars.platform: güvenilir tespitte etiket, düşük güven / bilinmiyor / yok → boş
  const mkSite = (domain: string, platform: (typeof s.stores.$inferInsert)["platform"], confidence?: "high" | "medium" | "low", source = "manual") => {
    const id = mk(domain, domain.split(".")[0], `info@${domain}`);
    db.update(s.stores).set({ platform, source, platformEvidence: confidence ? { confidence, signals: [] } : null }).where(eq(s.stores.id, id)).run();
    return id;
  };
  const get = (id: number) => db.select().from(s.stores).where(eq(s.stores.id, id)).get()!;
  const nextHigh = mkSite("next-yuksek.com", "nextjs", "high");
  const nextLow = mkSite("next-dusuk.com", "nextjs", "low");
  const unknownSite = mkSite("bilinmeyen.com", "unknown", "low");
  const wpSite = mkSite("wp-site.com", "wordpress", "medium");
  const shopSite = mkSite("shop-site.com", "shopify", "high");
  const legacySite = mkSite("eski-kayit.com", null); // platform yok, analiz edilmiş → Shopify sayılır
  assert.equal(storeVars(get(nextHigh)).platform, "Next.js");
  assert.equal(storeVars(get(nextLow)).platform, "", "düşük güvenli tespit mail'e girmemeli");
  assert.equal(storeVars(get(unknownSite)).platform, "");
  assert.equal(storeVars(get(wpSite)).platform, "WordPress");
  assert.equal(storeVars(get(shopSite)).platform, "Shopify");
  assert.equal(storeVars(get(legacySite)).platform, "Shopify");
  // Şablonda yedek değer yoksa boş platform "eksik değişken" olarak raporlanır
  assert.deepEqual(render({ format: "text", subject: "x", bodyText: "{{platform}}", bodyHtml: null }, storeVars(get(nextLow))).missing, ["platform"]);
  assert.match(render({ format: "text", subject: "x", bodyText: "{{platform|web siteniz}}", bodyHtml: null }, storeVars(get(nextLow))).text, /web siteniz/);

  // --- Hedef kitle koruması: JS şablonu + karışık alıcılar
  const { createTemplate } = await import("../src/lib/template-store");
  const { audienceMismatchReport, removeAudienceMismatches } = await import("../src/lib/campaigns");
  const jsTpl = createTemplate({ name: "Test JS", format: "text", audience: "js", subject: "{{marka}} sitesi", bodyText: "Merhaba {{marka}}\n\n{{imza}}\n\n\"çıkar\" yazmanız yeterli", bodyHtml: null });
  const allTpl = createTemplate({ name: "Test Tümü", format: "text", audience: "all", subject: "{{marka}} sitesi", bodyText: "Merhaba {{marka}}\n\n{{imza}}\n\n\"çıkar\" yazmanız yeterli", bodyHtml: null });
  const accGeneral = await createGmailAccount({ email: "genel@gmail.com", fromName: "Genel", password: "abcd efgh ijkl mnop", dailyLimit: 100, signature: "Genel" });
  const mixed = createCampaign([nextHigh, wpSite, shopSite, legacySite, unknownSite]);
  assert.equal(mixed.added, 5);
  updateCampaignSettings(mixed.id, { name: "Karışık", templateId: jsTpl.id, accountId: accGeneral.id, perHour: 200 });
  const rep = audienceMismatchReport(mixed.id)!;
  assert.equal(rep.count, 4, "wp, shopify, eski kayıt (Shopify) ve bilinmeyen platform JS şablonuna uymaz");
  assert.equal(rep.audience, "js");
  assert.throws(() => startCampaign(mixed.id), /yalnızca .* için hazırlanmış.*4 alıcı/);
  assert.equal(getCampaign(mixed.id)!.status, "draft");
  // Şablonu "Tümü" yapınca engel kalkar
  updateCampaignSettings(mixed.id, { name: "Karışık", templateId: allTpl.id, accountId: accGeneral.id, perHour: 200 });
  assert.equal(audienceMismatchReport(mixed.id), null);
  // JS'e dön, uymayanları çıkar → yalnızca Next.js alıcısı kalır ve başlatılabilir
  updateCampaignSettings(mixed.id, { name: "Karışık", templateId: jsTpl.id, accountId: accGeneral.id, perHour: 200 });
  assert.equal(removeAudienceMismatches(mixed.id), 4);
  assert.equal(audienceMismatchReport(mixed.id), null);
  assert.equal(getCampaign(mixed.id)!.counts.queued, 1);
  startCampaign(mixed.id);
  assert.equal(getCampaign(mixed.id)!.status, "running");
  assert.throws(() => removeAudienceMismatches(mixed.id), /duraklat/, "çalışan kampanyadan alıcı çıkarılamaz");
  await tickCampaigns(Date.now() + 5_000);
  const sentJs = listRecipients(mixed.id).rows.find((r) => r.email === "info@next-yuksek.com")!;
  assert.equal(sentJs.status, "sent");
  assert.equal(sentJs.vars.platform, "Next.js");
  console.log("hedef kitle kontrolleri geçti");

  // --- Mail alt bilgisi (HTML footer): düz metin ve HTML şablonlara eklenir, düz metin alternatifi üretilir
  const { saveEmailFooter, getEmailFooter, EMAIL_FOOTER_KEY, EMAIL_FOOTER_SEEDED_KEY } = await import("../src/lib/email-footer");
  const { sendTest } = await import("../src/lib/campaigns");
  const FOOTER = `<tr><td style="padding-top:22px;"><div>Dijital Craft</div><a href="https://www.dijitalcraft.com">dijitalcraft.com</a> <a href="mailto:info@dijitalcraft.com">info@dijitalcraft.com</a><div>Bu notu almak istemezseniz “çıkar” yazarak yanıtlayın.</div></td></tr>`;
  const textTpl = { format: "text" as const, subject: "x", bodyText: "Merhaba <Ali>\n\nİyi çalışmalar", bodyHtml: null };
  assert.match(getEmailFooter() ?? "", /dijitalcraft-mark\.png/, "kayıt yokken varsayılan alt bilgi yazılır");
  assert.match(getEmailFooter() ?? "", /instagram\.com\/dijitalcraftcom/);
  saveEmailFooter("");
  assert.equal(getEmailFooter(), null, "temizlenen varsayılan alt bilgi geri gelmez");
  db.$client.prepare(`DELETE FROM kv WHERE key IN (?, ?)`).run(EMAIL_FOOTER_KEY, EMAIL_FOOTER_SEEDED_KEY);
  assert.match(getEmailFooter() ?? "", /dijitalcraft-mark\.png/, "bayrak silinince varsayılan yeniden yazılır");
  saveEmailFooter("");
  assert.equal(getEmailFooter(), null);
  assert.equal(render(textTpl, {}).html, null, "alt bilgi yokken düz metin mail HTML'siz kalır");
  assert.equal(render(textTpl, {}, { footerHtml: "   " }).html, null, "boş alt bilgi eklenmez");

  const withFooter = render(textTpl, {}, { footerHtml: FOOTER });
  assert.ok(withFooter.html, "alt bilgiyle düz metin mail HTML de taşır");
  assert.match(withFooter.html!, /Merhaba &lt;Ali&gt;<br><br>İyi çalışmalar/, "metin kaçışlanıp birebir HTML'e çevrilmeli");
  assert.match(withFooter.html!, /<table role="presentation"[^>]*><tbody><tr><td/, "<tr> alt bilgi tabloya sarılmalı");
  assert.match(withFooter.html!, /href="https:\/\/www\.dijitalcraft\.com"/);
  assert.match(withFooter.text, /^Merhaba <Ali>\n\nİyi çalışmalar\n\nDijital Craft/, "düz metin alternatifi gövde + alt bilgi");
  assert.match(withFooter.text, /dijitalcraft\.com \(https:\/\/www\.dijitalcraft\.com\)/);
  assert.match(withFooter.text, /info@dijitalcraft\.com(?! \()/, "mailto bağlantısı yalnızca adres olarak yazılmalı");
  assert.doesNotMatch(withFooter.text, /mailto:|<td|<div/);
  assert.match(withFooter.text, /“çıkar” yazarak yanıtlayın/);

  const htmlTpl = { format: "html" as const, subject: "x", bodyText: "", bodyHtml: "<html><body><p>Selam</p></body></html>" };
  const htmlWith = render(htmlTpl, {}, { footerHtml: FOOTER });
  assert.ok(htmlWith.html!.indexOf("Selam") < htmlWith.html!.indexOf("Dijital Craft") && htmlWith.html!.indexOf("Dijital Craft") < htmlWith.html!.lastIndexOf("</body>"), "HTML şablonda alt bilgi </body> öncesine gelir");
  assert.equal((htmlWith.html!.match(/<\/body>/g) ?? []).length, 1);
  assert.match(htmlWith.text, /Selam[\s\S]*Dijital Craft/);
  const divFooter = render(textTpl, {}, { footerHtml: "<p>Alt not</p>" });
  assert.match(divFooter.html!, /<div style="margin-top:24px;"><p>Alt not<\/p><\/div>/, "<tr> olmayan HTML olduğu gibi eklenir");

  // Kayıt doğrulaması ve kampanya akışı (önizleme + test gönderimi) alt bilgiyi kullanır
  assert.equal(saveEmailFooter("<script>alert(1)</script>").ok, false);
  assert.equal(saveEmailFooter("<form></form>").ok, false);
  assert.equal(saveEmailFooter("x".repeat(20_001)).ok, false);
  assert.equal(getEmailFooter(), null, "reddedilen alt bilgi kaydedilmemeli");
  assert.equal(saveEmailFooter(FOOTER).ok, true);
  assert.equal(getEmailFooter(), FOOTER.trim());
  assert.match(previewRecipient(mixed.id)!.email.html ?? "", /Dijital Craft/, "kampanya önizlemesi alt bilgiyi içermeli");
  const tested = await sendTest(accGeneral.id, "alici@ornek.com", textTpl, { marka: "X" }, { prefix: false });
  assert.match(tested.html ?? "", /Dijital Craft/, "test gönderimi alt bilgiyi içermeli");
  saveEmailFooter("");
  assert.equal(getEmailFooter(), null, "boş kayıt alt bilgiyi kaldırır");

  // --- Inline CID görseller: uzak <img src="https://..."> gönderimde MIME inline ekine dönüşür
  const { inlineRemoteImages, clearInlineImageCache } = await import("../src/lib/inline-images");
  clearInlineImageCache();
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fetchedUrls: string[] = [];
  const fakeFetch = async (url: string) => {
    fetchedUrls.push(url);
    if (url.includes("bozuk")) return null;
    return { content: fakePng, contentType: "image/png" };
  };
  const imgHtml = `<div><img src="https://dijitalcraft.com/logo.png?v=1&amp;w=40" alt="DC"><img src="https://dijitalcraft.com/logo.png?v=1&amp;w=40"><img src="https://dijitalcraft.com/bozuk.png"></div>`;
  const inlined = await inlineRemoteImages(imgHtml, { fetchImage: fakeFetch });
  assert.equal(inlined.attachments.length, 1, "aynı URL tek ek olur, bozuk URL atlanır");
  assert.equal(inlined.attachments[0].filename, "logo.png");
  assert.equal(inlined.attachments[0].contentDisposition, "inline");
  assert.equal(inlined.attachments[0].cid, "inline-img-1@ulak.local");
  assert.deepEqual(fetchedUrls, ["https://dijitalcraft.com/logo.png?v=1&w=40", "https://dijitalcraft.com/bozuk.png"]);
  assert.equal((inlined.html.match(/cid:inline-img-1@ulak\.local/g) ?? []).length, 2, "aynı URL'nin iki kullanımı da aynı cid'i alır");
  assert.match(inlined.html, /src="https:\/\/dijitalcraft\.com\/bozuk\.png"/, "indirilemeyen görsel orijinal URL ile kalır");

  // sendEmail üzerinden kurumsal SMTP MIME çıktısında CID eki ve referansı yer alır
  let rawWithCid = "";
  await sendEmail(
    smAccount,
    { to: "alici5@ornek.com", subject: "CID test", text: "Merhaba", html: `<p>Selam</p><img src="https://dijitalcraft.com/logo.png">` },
    {
      fetchImage: fakeFetch,
      appendSent: async (_cfg, raw) => {
        rawWithCid = raw.toString("utf8");
      },
    },
  );
  assert.match(rawWithCid, /Content-ID: <inline-img-1@ulak\.local>/i);
  assert.match(rawWithCid, /Content-Disposition: inline; filename=logo\.png/i);
  assert.match(rawWithCid, /cid:inline-img-1@ulak\.local/);
  console.log("alt bilgi ve CID görsel kontrolleri geçti");

  // --- Mağaza eksiği (bulgu) değişkeni: DB'den okunur, şablona doğru yansır
  const withFinding = db
    .insert(s.stores)
    .values({
      domain: "bulgu.com",
      brandName: "Bulgu Butik",
      status: "done",
      findings: [
        { key: "broken_links", label: "1 kırık menü bağlantısı", detail: "Açılmayan sayfalar: /pages/kayip", sentence: "Sitenizin menüsünde açılmayan bağlantılar var." },
        { key: "no_contact", label: "İletişim sayfası yok", detail: "x", sentence: "Sitenizde iletişim sayfası görünmüyor." },
      ],
    })
    .returning()
    .get();
  const vf = storeVars(withFinding);
  assert.match(vf.bulgu, /^Sitenizin menüsünde açılmayan bağlantılar var\. Bunların çoğu mevcut temanızı/, "en öncelikli bulgu kullanılmalı");
  const withoutFinding = db.insert(s.stores).values({ domain: "temiz.com", status: "done", findings: [] }).returning().get();
  assert.equal(storeVars(withoutFinding).bulgu, "", "bulgu yoksa değişken boş olmalı");
  const legacy = db.insert(s.stores).values({ domain: "eski-analiz.com", status: "done" }).returning().get();
  assert.equal(storeVars(legacy).bulgu, "", "eski analizde (findings null) değişken boş olmalı");
  console.log("mağaza eksiği değişkeni kontrolleri geçti");

  // --- Eksik filtresi: URL (de)serileştirme ve sorgu
  assert.equal(parseFilters(new URLSearchParams("bulgu=yes")).findings, "yes");
  assert.equal(parseFilters(new URLSearchParams("bulgu=bilinmez")).findings, undefined, "geçersiz değer yok sayılmalı");
  assert.equal(serializeFilters({ ...DEFAULT_FILTERS, findings: "unanalyzed" }).get("bulgu"), "unanalyzed");
  const domainsFor = (findings: StoreFilters["findings"]) =>
    queryStores({ ...DEFAULT_FILTERS, pageSize: 1000, findings }).rows.map((r) => r.domain);
  const yes = domainsFor("yes");
  const no = domainsFor("no");
  const unanalyzed = domainsFor("unanalyzed");
  assert.ok(yes.includes("bulgu.com") && !yes.includes("temiz.com") && !yes.includes("eski-analiz.com"), "var: yalnız bulgulu mağaza");
  assert.ok(no.includes("temiz.com") && !no.includes("bulgu.com") && !no.includes("eski-analiz.com"), "yok: yalnız bulgusuz analiz edilmiş mağaza");
  assert.ok(unanalyzed.includes("eski-analiz.com") && !unanalyzed.includes("bulgu.com") && !unanalyzed.includes("temiz.com"), "eski analiz: findings NULL ve done");
  assert.equal(domainsFor(undefined).length, queryStores({ ...DEFAULT_FILTERS, pageSize: 1000 }).rows.length);
  console.log("eksik filtresi kontrolleri geçti");

  console.log("\n✓ tüm kontroller geçti");
}

main().finally(() => {
  db.$client.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});
