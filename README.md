# Mail Templater

Shopify mağazalarını bul → analiz et → filtrele → şablonlu mail gönder. Tamamen yerel ve ücretsiz.

> AI araçları (Claude Code, Cursor vb.) için proje bağlamı: [AGENTS.md](AGENTS.md)

## Çalıştırma

```bash
npm install
cp .env.example .env   # değerleri doldurun (açıklamalar dosyada)
npm run dev        # veritabanı migration + web (localhost:3000) + worker
```

`npm run dev` iki süreç açar:
- **web**: Next.js arayüzü
- **worker**: arka planda analiz (ve ileride gönderim) işlerini yürütür

Veritabanı `data/app.db` dosyasındadır (SQLite, git'e girmez).

**Gizli dosyalar (git'e girmez, yedekleyin):** `.env` (şifreleme anahtarı `APP_SECRET_KEY`, Outlook Client ID) ve `data/` klasörü. `APP_SECRET_KEY` kaybolursa kayıtlı hesap şifreleri çözülemez.

## Faydalı komutlar

| Komut | Ne yapar |
|---|---|
| `npm run analyze -- ornek.com.tr` | Tek bir alan adını terminalde analiz eder (DB'ye yazmaz) |
| `npm run test:campaign` | Gönderim motoru testi (ayrı test DB, mail ağa çıkmaz) |
| `npm run db:generate` | Şema değişince yeni migration üretir |
| `npm run db:studio` | Veritabanını tarayıcıda görüntüler |
| `npm run typecheck` / `npm run lint` | Kontroller |

## Yapı

```
src/db/              şema (Drizzle) ve bağlantı
src/lib/analyzer/    Shopify tespiti, meta/products, mail bulma, TR puanı
src/lib/jobs.ts      SQLite tabanlı iş kuyruğu
src/lib/stores.ts    mağaza ekleme/listeleme/analiz kaydı
src/app/stores/      Mağazalar ekranı
worker/              arka plan işçisi
drizzle/             migration dosyaları
```

## Yol haritası

- [x] F0 Kurulum
- [x] F1 Mağaza ekleme + analiz
- [x] F2 Liste, filtreler, sıralama, sayfalama, CSV, detay paneli
- [x] F3 Şablonlar, Gmail hesabı + imza, kampanyalar, saatlik/günlük sınırlı gönderim, kara liste
- [x] F4 Otomatik keşif (DuckDuckGo araması, Common Crawl, DNS listesi)
- [x] F5a Outlook (kişisel hesap, OAuth)
- [ ] F5b Yanıt/bounce takibi (IMAP), takip maili
