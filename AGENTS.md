# AGENTS.md — Mail Templater

Context for AI coding agents (Claude Code, Cursor, Codex, Copilot…). Read this before changing code.

## What this project is

A **local, single-user outreach tool** for a Turkish agency owner who sells **web development services**. It:

1. **Finds websites** (manual paste/CSV, plus automatic discovery): Shopify stores and general sites (custom frameworks such as Next.js, React, Angular, Vue; WordPress; Wix; corporate sites).
2. **Analyzes each site** from public endpoints: platform (Shopify, Next.js, React, Angular, Vue/Nuxt, WordPress, Wix, Webflow, custom, unknown), brand name, country, currency, language, **a contact email** scraped from the site, and, for Shopify stores only: category, product count, price range, last product date, theme, installed apps, socials.
3. Lets the user **filter and select** sites in a table, by platform and TR score among other things.
4. **Sends one email template to the selected sites** from the user's own **Gmail or Outlook** account. Each email is personalized with variables like `{{marka}}` (brand name) and `{{platform}}` (for example "Next.js"). Sending is throttled (e.g. 100/hour), and the user starts it with a button.

Target market: **global, but Turkey-first**. Each site gets a `tr_score` (0–100) and the UI favors TR sites by default.

Product scope (decided 2026-11-26): the offer is web development for sites built with custom frameworks (Next.js, React, Angular) and other platforms. Shopify is one platform among several, not the whole product. Shopify-only fields and filters stay, but they only apply to sites with `platform = shopify`. Pitch copy must not assume the recipient uses Shopify.

## Hard constraints (product decisions, don't relitigate)

- **100% free.** No paid APIs or services (no StoreLeads/BuiltWith/Hunter/ZeroBounce/SerpAPI, no paid ESPs). Use only public endpoints, free data such as Common Crawl, DNS, and the user's own mailbox.
- **Sending goes only through the user's own mailbox: free Gmail, free personal Outlook, or the user's own corporate mailbox over plain SMTP.**
  - Corporate mail (added 2026-11-25, provider `smtp`): any hosting mailbox the user owns, via host/port/SSL-or-STARTTLS/username/password (e.g. `mail.guzel.net.tr:465` SSL/TLS). The settings are stored encrypted as JSON `{host,port,secure,user,password}` in `accounts.secret`. The connection is verified before saving. Default daily limit is 100 (hosting limits are unknown). Gmail and Outlook support stays unchanged.
  - Gmail: SMTP + **App Password** via Nodemailer. We deliberately do **not** use the Gmail API: unverified OAuth apps get refresh tokens that expire every 7 days.
  - Outlook (**personal accounts only**, decided 2026-11-20): OAuth 2.0 auth-code + **PKCE** (public client, no secret) against the `consumers` authority, then **SMTP `smtp-mail.outlook.com:587` with XOAUTH2** (scope `https://outlook.office.com/SMTP.Send`). We use SMTP rather than Graph because Graph cannot set `List-Unsubscribe`. The user registers a free Azure app once ("Personal Microsoft accounts only", platform "Mobile and desktop", redirect `http://localhost:3000/api/oauth/outlook/callback`) and provides the Client ID via `.env` `OUTLOOK_CLIENT_ID` (preferred, read-only in the UI) or pastes it in Settings (kv `outlook_client_id`). The refresh token is stored encrypted as JSON in `accounts.secret`, and every rotated refresh token is persisted. Default daily limit is 150 because Microsoft flags new personal accounts quickly.
- **No cron or scheduled sends.** The user clicks "start" and the worker sends in throttled batches. Pause, resume and stop must work. Respect the account's daily cap (Gmail ~500/day, use ≤400; Outlook ~300/day, use ≤250) and stop automatically when the cap is reached.
- **Spread sends randomly** across the hour (e.g. 100/hour ≈ one every ~36s ± jitter). Never burst.
- **Local-only app.** No auth, no multi-tenant, no deployment target. Credentials live on the user's machine.
- **Emails are plain text** (decided 2026-11-20): no designed HTML templates. A minimal HTML part that mirrors the text is OK, but the email must look hand-written: no images, no tracking pixels, few links.
- **No per-store "findings/audit" personalization for now** (shelved 2026-11-20). An earlier idea was to detect each store's problems (old theme, broken nav links, missing reviews, PageSpeed) and mention one in the email. Don't build it unless the user revives it. Mentioning the detected platform (for example "Next.js ile yazılmış siteniz") is NOT a findings audit and is allowed.
- **Compliance basics:** every email needs an opt-out, either a `List-Unsubscribe: mailto:` header or a "reply 'çıkar'" line. Keep a suppression list that is always honored. Never email the same address twice in one campaign.
- **UI language is Turkish.** All user-facing strings are Turkish. Code identifiers are English; comments may be Turkish.

## Stack

- **Next.js 16 (App Router, Turbopack)** with `cacheComponents: true` and `partialPrefetching: true`. **Read `node_modules/next/dist/docs/` before using Next APIs**; see the managed block at the end of this file.
- React 19, TypeScript (strict), Tailwind CSS v4. No component library; small hand-written components.
- **SQLite** (`better-sqlite3`, WAL mode) + **Drizzle ORM**. DB file: `data/app.db` (gitignored).
- **cheerio** for HTML parsing, Node `fetch` for HTTP, `node:dns` for MX checks.
- **Worker**: a separate Node process (`tsx worker/index.ts`) that polls a SQLite `jobs` table. `npm run dev` starts web + worker together via `concurrently`.

## Layout

```
src/db/schema.ts          Drizzle schema: stores, contacts, jobs, kv
src/db/index.ts           DB singleton (shared by Next and worker)
src/lib/domains.ts        normalizeDomain / extractDomains (punycode, www-strip) / sameSite
src/lib/analyzer/         Pure analysis, no DB writes:
  index.ts                  analyzeStore(domain) → AnalysisResult; Shopify path, or analyzeGeneralSite for other platforms (F6)
  http.ts                   fetchPage (UA, timeout, 429 retry, size cap), fetchJson, describeError (TR messages)
  storefront.ts             Shopify detection, meta.json/products.json parsing, theme/apps/socials, computeTrScore
  platform.ts               detectPlatform(html, headers, cnames) → platform + confidence + signals (F6, pure)
  emails.ts                 email extraction/cleanup/ranking, MX check (cached)
src/lib/jobs.ts           job queue: enqueue / claimJobs (atomic UPDATE…RETURNING) / retry / heartbeat
src/lib/stores.ts         store CRUD, saveAnalysis, contacts logic, filtered queries, facets, stats
src/lib/store-filters.ts  StoreFilters type + URL (de)serialization (incl. `tip` kind and `platform`). Shared client/server, NO db imports
src/lib/format.ts         Turkish display helpers (status labels, country/language names, money, relative time)
src/lib/template.ts       template engine: {{var}} / {{var|fallback}}, renderEmail, htmlToText, DEFAULT_TEMPLATE, starter templates (STARTER_BATCHES, one flag per batch). Pure, client-safe
src/lib/template-audience.ts template audience (all/shopify/general/js/wordpress) labels + audienceAccepts(audience, site). Pure, client-safe (F6 Faz 5)
src/lib/template-store.ts templates CRUD (+ seeds the user's default plain-text template)
src/lib/accounts.ts       sender accounts (Gmail, Outlook, corporate SMTP), sentInLast24h (rolling window)
src/lib/secret.ts         AES-256-GCM for account secrets; key = env APP_SECRET_KEY (64 hex), fallback data/secret.key. Losing it makes saved accounts unreadable
src/lib/env.ts            loadDotEnv(): loads .env.local/.env for worker and scripts (Next loads them itself). Called from src/db/index.ts
src/lib/mailer.ts         Nodemailer: Gmail SMTP (465, app password), Outlook SMTP (587, XOAUTH2) and generic corporate SMTP (`smtp` provider). List-Unsubscribe header, provider-aware classifySendError, DRY-RUN via MAIL_TRANSPORT=json
src/lib/outlook.ts        Microsoft OAuth (PKCE, consumers): authorize URL, code exchange, cached access token + refresh-token rotation, explainMicrosoftError (AADSTS → Turkish fix hints)
src/lib/settings.ts       getSetting/setSetting on kv
src/app/api/oauth/outlook/  start (sets httpOnly state+verifier cookie → Microsoft) and callback (verify state, exchange, SMTP verify, upsert account)
src/lib/campaigns.ts      campaign create (with filtering) / settings / start / pause / stop / retry, preview, tickCampaigns (worker), sendTest
src/lib/suppression.ts    suppression list (never-send); labels in suppression-labels.ts (client-safe)
src/lib/campaign-labels.ts client-safe status labels
src/app/stores/           Stores screen: page (server), filters-bar, stores-table, store-drawer, actions, export/route.ts (CSV)
src/app/templates/        list (audience badge) + [id] editor (audience select, live preview filtered by audience, variable chips, content hints, test send)
src/app/campaigns/        list + [id] detail (settings, start/pause/stop, progress, ETA, countdown, preview, recipients)
src/lib/discovery/        F4 discovery: probe.ts (meta.json → shopify/TR/primary domain), ddg.ts (DuckDuckGo HTML + query builder + default TR keywords), commoncrawl.ts (CDX with retries), dns.ts (Shopify IP/CNAME, resolver with timeout), domainlist.ts (Common Crawl web-graph domain list → .tr, streamed with Range resume, cached in data/discovery/), tranco.ts (top-1M list, cached), wayback.ts (Wayback CDX *.myshopify.com pages), runs.ts (discovery_runs CRUD), runner.ts (resumable runs, ingest pipeline, shared dnsSweep, injectable RunnerDeps for tests)
src/lib/discovery/general-probe.ts  F6: homepage probe for general sites (reachable, shopify signal, platform). source-groups.ts: which sources belong to the Genel tab (client-safe)
src/lib/platform-labels.ts platform display names, general platform choices and defaults, `siteKind()` / `effectivePlatform()` (client-safe)
src/app/discover/         discovery screen: 2 tabs (Shopify / Genel), forms per tab, run cards (progress, stats, note, wait, log, cancel/resume)
src/app/settings/         Gmail accounts (app password + signature), corporate SMTP accounts, Outlook setup + connect/reconnect, suppression list
src/components/           nav, multi-select, auto-refresh, ui.ts (shared Tailwind class strings)
worker/index.ts           two loops: job queue (concurrency 6) + send loop (every 2s → tickCampaigns). Graceful shutdown waits for an in-flight send
scripts/migrate.ts        applies drizzle/ migrations (runs before dev/start)
scripts/analyze.ts        CLI: `npm run analyze -- domain.com` (prints AnalysisResult, no DB)
scripts/test-campaign.ts  sending-engine test on a throwaway DB, no network: `npm run test:campaign`
drizzle/                  generated SQL migrations (commit these)
```

## Data flow

```
paste/CSV → addStores() → stores(status=pending) + jobs(analyze_store)
worker → claimJobs() → runStoreAnalysis() → analyzeStore() → saveAnalysis() → stores + contacts
UI (/stores) → parseFilters(searchParams) → queryStores() → table / drawer (?detail=id)
select stores → createCampaign() → campaign(draft) + campaign_recipients(queued, vars snapshot from store)
start → template snapshot copied onto campaign → worker tickCampaigns() → sendEmail() → recipient sent/failed/skipped
```

**Sending rules** (in `src/lib/campaigns.ts`, covered by `npm run test:campaign`):
- On creation, these are filtered out: stores without a primary email, MX=false, suppressed addresses, addresses already sent in ANY campaign, and duplicate emails.
- They are re-checked at send time (suppression, sent elsewhere).
- Pacing: the next send is at `now + (3600/perHour) * U(0.5, 1.5)` seconds. There is a hard cap of `perHour` sends in any rolling hour per campaign.
- Daily cap: `account.dailyLimit` per rolling 24h across all campaigns. When it is hit, the campaign auto-pauses with a Turkish `statusReason`. The user resumes manually (no cron, by design).
- Error handling:
  - `auth` and `quota` errors put the recipient back in the queue and pause the campaign.
  - `recipient` (5xx on RCPT) marks the recipient failed and adds it to suppression.
  - `transient` errors retry up to 3 times, 60s apart.
- A recipient left in `sending` after a crash is marked failed and NOT retried automatically, to avoid double-sending.
- One send at a time per account. The campaign is marked `completed` immediately after the last recipient.
- Gmail SMTP accepts bad addresses and bounces later by email. Detecting those needs IMAP (F5).
- The `List-Unsubscribe` header is on by default and can be turned off in Settings (kv `list_unsubscribe_header=off`). At low volume it can read as a bulk signal. The in-body opt-out sentence must stay either way.
- Deliverability lessons from the first real test (2026-11-20, outlook.com → Gmail went to spam):
  - Free-hosting links (`*.vercel.app` etc.) and pitch-style "Shopify development" copy are strong spam signals. The template editor warns about free-hosting links.
  - Test sends can skip the `[TEST]` prefix so they match real sends.

Store statuses: `pending | analyzing | done | not_shopify | password | unreachable | error`. `done` means any analyzed site (since F6 Faz 2). `platform` says which platform it is; Shopify-only fields apply only when `platform = shopify`.

**Contacts rules** (in `src/lib/stores.ts`, all covered by manual tests):
- Each store has exactly one `is_primary` contact if it has any contacts. Campaigns send to the primary.
- `is_manual` contacts (added by the user) are never deleted by re-analysis.
- `pinned` = the user chose this contact as primary. Re-analysis keeps that choice while the contact still exists.
- Auto-found contacts that disappear from the site are deleted on re-analysis.

## Conventions and gotchas (learned the hard way)

- **Drizzle correlated subqueries:** in single-table selects, Drizzle renders `${stores.id}` as bare `"id"`. Inside `(SELECT … FROM contacts c WHERE c.store_id = …)` that silently binds to `contacts.id`. **Write `stores.id` literally** in raw `sql` subqueries.
- **Pages that read SQLite:** `better-sqlite3` is synchronous and `cacheComponents` is on. Put DB-reading UI in an async child component wrapped in `<Suspense>`, and call `await connection()` first. Otherwise Next prerenders the data or warns about blocking or unstable values. See `src/app/stores/page.tsx`.
- **React purity lint:** don't call `Date.now()` directly in a component body. Use `nowMs()` from `lib/format.ts` on the server and pass `now` down as a prop.
- **Mutations** are Server Actions (`"use server"` files) that call `refresh()` from `next/cache`. Validate inputs: actions are public endpoints even in a local app.
- **Bulk targets:** a bulk action takes either `{ ids }` or `{ filter: <querystring> }`, which means "all stores matching the filter" (`resolveTarget` in `app/stores/actions.ts`).
- **Filters live in the URL** (`serializeFilters` / `parseFilters`) so they survive reloads.
- **Schema changes:** edit `src/db/schema.ts` → `npm run db:generate -- --name <change>` → commit the generated SQL. Migrations auto-apply on `npm run dev`.
- **Raw SQL:** use `db.$client.prepare(...)` when Drizzle gets in the way (e.g. `UPDATE … RETURNING`, `json_each`).
- **Email text extraction:** join text nodes with spaces, not `$.text()`. Adjacent elements otherwise glue together (`info@x.com` + `Phone` → `info@x.comphone`).
- **Be polite when crawling:** keep concurrency modest, use timeouts, retry once on 429, and stop crawling a store's extra pages once a same-domain email is found.
- **Server → client props must be serializable**: pass a URL pattern string, not a function (see `previewHrefPattern` in campaigns).
- **Client components must not import modules that import `@/db`**. Put labels and pure helpers in client-safe files (`*-labels.ts`, `template.ts`, `store-filters.ts`, `format.ts`). Type-only imports are fine.
- `usePathname()` in the root layout's nav must stay inside `<Suspense>` (partialPrefetching insight).
- **Testing sends safely:** `DB_FILE=data/demo.db MAIL_TRANSPORT=json npm run dev` runs the whole app on a separate DB, and no email leaves the machine. Never test campaigns against `data/app.db` with a real account.
- On Windows dev machines, Python may not be installed; use Node for scripting. Stopping `npm run dev` from a tool may leave orphan node processes holding port 3000. Kill node processes whose command line contains the project path.

## Secrets

- **Gitignored:**
  - `.env`: `APP_SECRET_KEY`, `OUTLOOK_CLIENT_ID`. The template is `.env.example`, which is committed.
  - `data/`: the DB with encrypted account secrets, contacts and campaigns; the `secret.key` fallback; test DBs.
- Never print or log secret values. Never commit `.env` or `data/`.

## Commands

```
npm run dev          migrate + web (localhost:3000) + worker
npm run typecheck    tsc --noEmit
npm run lint         eslint
npm run analyze -- example.com   debug the analyzer on real domains
npm run test:campaign            sending engine test (throwaway DB, dry-run transport)
npm run test:discovery           discovery test: resilience, parallel sources, domain list/Tranco/Wayback (throwaway DB, fakes, no network)
npm run test:filters             Stores screen kind/platform filters, stats, facets, CSV (throwaway DB, no network)
npm run test:platform            platform detection fixtures (pure, no network)
npm run test:site                general/Shopify site analysis on a local HTTP server (no internet)
npm run pilot:general            real-network pilot of general site discovery on a random sample of the cached .tr list (no DB writes)
npm run db:generate  create a migration after schema edits
npm run db:studio    browse the DB
```

Before finishing a change, run `npm run typecheck && npm run lint`. For analyzer changes, run `npm run analyze` against a few real stores. Load the affected page with `npm run dev` running and check the terminal for Next.js warnings.

## Roadmap and status

- [x] **F0** Scaffold (Next + SQLite + Drizzle + worker)
- [x] **F1** Add stores (paste/CSV) → analyze → table
- [x] **F2** Filters (status, country, language, currency, apps, source, email, TR score, activity, category, product range, search), sorting, pagination, select-all-matching, bulk re-analyze/delete, CSV export, detail drawer with contact management
- [x] **F3** Templates (plain text default, optional HTML), Gmail accounts with signature (`{{imza}}`), campaigns from store selection, throttled sending with daily cap and auto-pause, suppression list, test send, "already emailed" store filter
- [x] **F4** Automatic discovery (all free). Findings from live probes (2026-11-20):
  - **DuckDuckGo** HTML: `site:myshopify.com <tr keyword>` works well; most results are Turkish Shopify stores. It only serves the first page (10 results): next-page POSTs and `inurl:` queries get 202. Volume therefore comes from keyword × variation queries, spaced 10–16s apart (× an adaptive `pace` up to 3 after blocks). On 202 it auto-waits 5/10/20/30/30 min and continues; only after all of these (≈95 min of blocks in a row) does it stop as `blocked` (resumable, "Devam ettir" resets the counter). Network errors retry after 30s/60s/120s. `stats.waitUntil/waitReason/blockStreak` persist the wait so a worker restart does not hit DDG immediately; the run card shows "… HH:MM civarında otomatik devam edecek". Common Crawl pages get two extra retries (2 and 5 min). Covered by `npm run test:discovery` (fake search + clock, no network).
  - Bing, Mojeek and Brave show captchas; don't use them.
  - **Common Crawl** CDX: `pageSize=1` gives ~100 stores per page, but the server often returns 504 (we retry 4× with backoff). Turkish ratio is under 1%, so use it with the TR filter.
  - **DNS**: apex A `23.227.38.*` or www CNAME `*.myshopify.com`.
  - The ingest pipeline: skip known (domain or myshopify_domain) → `probeStore` (meta.json) → TR filter → add by **primary domain**. Analysis marks later twins (same myshopify_domain) as status `duplicate`.
  - One active run **per source** (decided 2026-11-25); different sources run in parallel. Discovery jobs use their own worker slots (`DISCOVERY_SLOTS`, 8), so they never starve `analyze_store` jobs.
  - **Common Crawl domain list (.tr) + DNS** (source `ccdomains`, added 2026-11-25): it streams the web graph `domain-vertices.txt.gz` (~1 GB, sorted by reversed domain) and keeps only the `.tr` domains, stopping once it is past `tr`. That gave 231,625 domains in ~3 min. The list is cached in `data/discovery/<graph>-tr.txt`. DNS runs ~100 domains/s at 32 concurrent; about 0.3–0.45% are Shopify (≈700–1,000 TR stores, ~40 min). No search engine, no blocks.
  - **Tranco** top 1M + DNS (source `tranco`): the list id comes from `tranco-list.eu/top-1m-id` and the CSV from `/download/<id>/1000000`. The next start offset is derived from previous runs.
  - **Wayback CDX** (source `wayback`): `url=myshopify.com&matchType=domain&fl=urlkey&collapse=urlkey&page=N`, ~45k pages. It is slow (10–60s per page) and returns 1–200 hosts per page, with a TR ratio under 1%. Pages are spaced 4–8s apart; the next page is kept in kv `wayback_next_page`.
  - Google is not an option: the Custom Search JSON API has been closed to new customers since 2026-01-20 and shuts down 2027-01-01. HTML scraping hits captchas.
- (original F4 plan, kept for reference):
  - Common Crawl CDX index for `*.myshopify.com`, then resolve the real domain via `/meta.json`
  - Search-engine HTML results (slow, polite)
  - DNS check (Shopify IP `23.227.38.x` / CNAME `shops.myshopify.com`) for bulk domain lists
  - De-duplicate myshopify vs custom domains
- [x] **F5a** Outlook (personal) via OAuth PKCE + SMTP XOAUTH2. Not yet tested against a real Microsoft account. Routes, state checks and error paths were tested with a fake Client ID against the real Microsoft token endpoint.
- [ ] **F5b** IMAP reply/bounce tracking that auto-adds to suppression; follow-up emails
- [ ] **F6** General site discovery and platform detection (decided 2026-11-26; phases are finished one at a time, each verified before the next starts)
  - [x] **Faz 0** Product decisions and docs: this file updated (product scope, `{{platform}}`, Shopify-only fields, findings still shelved).
  - [x] **Faz 1** Platform detection: `src/lib/analyzer/platform.ts` (`detectPlatform`, weighted signals, parent suppression: Next.js over React, Nuxt over Vue). Platforms: shopify, nextjs, react, angular, vue, nuxt, wordpress, wix, webflow, ticimax, ikas, ideasoft, unknown ("custom" was dropped: "no signal" is not proof of custom code). Confidence high/medium/low. Migration `0005_platform` adds `stores.platform` and `stores.platform_evidence` (JSON `{confidence, signals}`), both nullable (null = not detected yet). Fixture tests: `npm run test:platform` (19 cases, no network). Not yet called from the analyzer; that is Faz 2.
  - [x] **Faz 2** General site analysis, inside `analyzeStore` (no separate entry point). Shopify path sets `platform = shopify` (confidence high if meta.json or theme markup, medium if only headers). Non-Shopify sites no longer get `not_shopify`: they go through `analyzeGeneralSite` (platform, brand from og:site_name/title, description, lang, socials, emails from homepage + up to 8 contact pages, MX, TR score from lang and `.tr` only). Status `done` now means any analyzed site. Verified: `npm run test:site` (local server, 6 cases) and `npm run analyze` on mock.shop, vercel.com, angular.dev, wordpress.org.
    - **Known gap:** headless Shopify (Hydrogen / custom Storefront frontends) is detected as `unknown`. `mock.shop` is one. Shopify detection needs classic markers, which headless sites lack.
    - ~~Known gap for Faz 4~~ (fixed in Faz 4): stats and filters are now platform-aware. Existing `not_shopify` rows count as general until re-analysis.
  - [x] **Faz 3** Discover screen tabs: `/discover` (Shopify Mağazaları) and `/discover?tab=genel` (Genel Siteler), with a Shopify/Genel badge on each run card. General sources: `general_ccdomains` (Common Crawl `.tr` list, `start`/`limit` slices like Tranco) and `general_tranco` (Tranco, `.tr`/`.com.tr` only when trOnly). Pipeline per domain (`generalSweep` in `runner.ts`): `.tr` filter → already listed? → DNS A record (`hasARecord`, 32 concurrent) → homepage probe (`probeSite` in `general-probe.ts`, 12 concurrent, 8 s timeout, one request, https→http) → Shopify signal = skipped (`stats.shopify`), unreachable = `stats.dead`, platform in the selected set = `addStores` (analysis then runs in the worker). Platform choices and defaults (`nextjs, react, angular, vue, nuxt, wordpress`, decided 2026-11-26) are in `platform-labels.ts`; the tab grouping is in `discovery/source-groups.ts`. Stats for general runs: `dead` is new (optional). `general_*` sources need no SQL migration (TS-only enum). Not done: DuckDuckGo general search (optional, low volume). `robots.txt` check: not done yet; crawl is one homepage request per domain plus DNS.
    - Tests: `npm run test:discovery` scenario 12 (fakes for DNS and probe, `.tr` filter, dead/Shopify/platform counts, re-run skips known).
    - Pilot (2026-11-26, `npm run pilot:general`, 1000 random `.tr` domains from the cached list, real network, no DB writes): 80% have an A record; 6% of the sample unreachable; 0.3% Shopify (headers/markup only); of reachable non-Shopify sites: unknown 62%, wordpress 31%, nextjs 3%, wix 2%, angular/react/vue <1% each. 29 sites (2.9% of the sample) match the default platforms: 21 Next.js, 4 Angular, 2 React, 2 Vue. Analysis of those 29: 59% have a contact email, 55% with a valid MX. Rough extrapolation to the full ~231k list: ~6,700 matched (95% CI roughly 4,000–9,000), ~3,900 with an email. Caveats: 29 matches is a small sample; ~1 of 8 spot-checked Next.js sites was İkas-hosted (`cdn.myikas.com`) and the `unknown` spot checks mostly looked like plain jQuery/Bootstrap sites (no missed frameworks in an 8-site check).
    - Fixes after the pilot (2026-11-26): (1) managed storefronts (`ikas`, `ticimax`, `ideasoft`) with a strong signal suppress the JS framework children (nextjs, react, angular, vue, nuxt), so an İkas site on Next chunks is `ikas`, not `nextjs`. (2) Non-sales addresses (`kvkk`, `privacy`, `gizlilik`, `legal`, `hukuk`, `abuse`, `dmca`, `iade`, `returns`, `refund`, `career`, `kariyer`, `ik`, `hr`, `jobs`, `muhasebe`, `fatura`, `accounting`) are dropped in `cleanEmail`, so they can never be primary (before, they were only ranked down). This also applies to Shopify stores and manual entry. (3) WordPress was added to the default general targets. The full discovery run has NOT been started yet.
    - **Targeting fixes (2026-11-26, after the first real run):** the first run found mostly lawyer and municipality sites plus very popular sites. Causes: (1) the cached `.tr` list is alphabetical by reversed domain and `start`/`limit` sliced it sequentially, so slice 0–5000 was 49% `.av.tr` (2,452 lawyer sites) plus 1,689 `.bel.tr`; (2) the `general_tranco` source is the top-1M popular list by definition. Target = small/medium businesses that may need a new site, NOT lawyers, news, public bodies or well-known sites.
    - Fixes in `general_ccdomains` (`discovery/domain-order.ts`, `discovery/segments.ts`, `runner.ts`): drop suffixes `.av.tr .gov.tr .edu.tr .bel.tr .k12.tr .mil.tr .pol.tr .kep.tr .tsk.tr`; walk the rest in a deterministic shuffle seeded by the graph id (stable across resumes, consecutive slices do not overlap); AFTER slicing (so the order never depends on the daily Tranco list) skip domains in the Tranco top 1M (`stats.popular`) and domains whose NAME has news/legal/public keywords (`haber gazete sondakika avukat hukuk belediye valilik …`); the homepage probe also returns a `segment` from `<title>`, `og:site_name` and JSON-LD `NewsMediaOrganization` (NOT the meta description, to avoid false positives), and those sites are skipped too (`stats.excluded`). If the Tranco list cannot be loaded the run stops as failed instead of scanning unfiltered (`popularDomains` dep; falls back to the newest cached `tranco-*.txt`).
    - The `general_tranco` source and its form were removed (the enum value stays so old rows keep a label; a run with that source fails with an explanation). `.org.tr` stays in (associations; real but rare customers). In the cached list: ~6,500 domains have news keywords, ~570 legal, ~60 public. Real-network check (600 random `.tr`, 2026-11-26): 8% excluded before any request, 5 of 600 excluded by homepage content, 152 matched the default platforms and looked like small businesses (construction, logistics, accounting, machinery, food). Old rows were cleaned with the same rules (2,013 deleted, DB backup in `data/app.backup-*.db`). Tests: `test:discovery` scenarios 12–14.
    - Optional next step if it still returns too many well-known sites: use the Common Crawl `domain-ranks.txt.gz` (2.7 GB stream) as a finer popularity cut than Tranco. Not built.
    - Local DB note: `data/app.db` was migrated (0005) during this phase because the dev server had shown `no such column: "platform"`. Restarting `npm run dev` does the same.
  - [x] **Faz 4** Table and filters (2026-11-26). Stores screen has a kind switch (Tümü / Shopify / Genel siteler, with counts, URL `?tip=shopify|genel`) and a Platform multi-select (URL `?platform=nextjs,wordpress`). Table has a Platform badge column (low-confidence detections get a "?" and the signals in the tooltip); in the "Genel siteler" view the Shopify-only columns (Eksik, Kategori, Ürün, Fiyat aralığı, Son ürün) and filters (Uygulama, Eksik, Son ürün, Kategori, Ürün sayısı, "Aktif (90 gün)") are hidden, and switching to it clears them. Stats gained "Genel site". The drawer shows the platform badge and hides Shopify-only rows/sections for general sites. CSV has `tur` and `platform` columns. Campaign creation and bulk actions reuse the same filter querystring (`parseFilters` → `queryStoreIds`), so "select all matching" with `tip`/`platform` filters works for campaigns without extra code.
    - **Kind rule** (one rule, two implementations that must stay in sync: `siteKind()` / `effectivePlatform()` in `platform-labels.ts` and `IS_SHOPIFY_SITE_SQL` / `EFFECTIVE_PLATFORM_SQL` in `stores.ts`): Shopify = `platform = shopify`, OR `platform` is null AND status is not `not_shopify` AND source does not start with `general_`. Everything else is general. This keeps pre-F6 rows (platform null, analyzed as Shopify) in the Shopify bucket; pending rows are classified by source. "Effective platform" is the detected platform, or `shopify` for legacy analyzed/password rows, or null while unknown (pending/unreachable/error).
    - Tests: `npm run test:filters` (throwaway DB: kind/platform filters, legacy rows, stats, facets, URL round trip, CSV columns, TS vs SQL rule parity).
  - [x] **Faz 5** Templates and campaigns (2026-11-26).
    - **`{{platform}}`** (`storeVars` in `campaigns.ts`): the display name ("Next.js", "WordPress", "Shopify"). It is EMPTY when the platform is `unknown` or the detection confidence is `low`, so the `{{platform|fallback}}` syntax applies and an email never claims "built with X" on a weak guess. Legacy analyzed rows with null platform count as Shopify. Always give a fallback in templates (the editor warns otherwise).
    - **Template audience** (`templates.audience`, migration `0006_template_audience`, existing templates became `shopify`): `all | shopify | general | js | wordpress`. `audienceAccepts` in `template-audience.ts` decides per site (uses `siteKind`/`effectivePlatform`). `js` = nextjs/react/angular/vue/nuxt. Platform-specific audiences (`js`, `wordpress`) reject sites whose platform is still unknown. Recipients whose store was deleted are accepted.
    - **Guard:** `startCampaign` (also resume) throws a Turkish error when queued recipients do not match the template audience. The campaign page shows the mismatch count with a "Uymayanları çıkar" button (`removeAudienceMismatches`, only when the campaign is not running). Covers the case of a Shopify pitch going to a Next.js site and vice versa.
    - **Starter templates v3** (flag `starter_templates_v3_general`, 4 plain-text templates: 2 `js`, 1 `wordpress`, 1 `general`): use only `{{marka}}`, `{{site}}`, `{{imza}}`, `{{platform|fallback}}`, no "Shopify", no links, with the `"çıkar" yazmanız yeterli` opt-out. Existing Shopify starters keep their copy and are tagged `shopify`. A user-deleted starter is not re-added.
    - **Editor:** audience select; preview samples are filtered by audience and cover every platform (`sampleStoresForPreview` takes up to 40 per platform); extra hints: "Shopify" in a non-Shopify template, `{{bulgu}}`/`{{kategori}}` outside Shopify audiences (those are Shopify-only), `{{platform}}` without fallback. Campaign settings show the audience next to each template.
    - Tests: `npm run test:campaign` (platform var, audience rules, guard, remove mismatches, v3 starters). Campaign creation from the Stores screen already reuses the `tip`/`platform` filters from Faz 4.
    - Still open: legal review before mass sending to general sites (Law 6563 / İYS, see below); F5b IMAP reply/bounce tracking.
  - Open before F6 Faz 3 (legal): commercial email to company addresses in Turkey falls under Law 6563 and the İYS rules. Get a legal review before any mass sending to general sites.

Note: crt.sh is **not** useful for finding stores. Shopify uses a wildcard cert for `*.myshopify.com`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
