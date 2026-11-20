# AGENTS.md — Mail Templater

Context for AI coding agents (Claude Code, Cursor, Codex, Copilot…). Read this before changing code.

## What this project is

A **local, single-user outreach tool** for a Turkish agency owner. It:

1. **Finds Shopify stores** (manual paste/CSV now; automatic discovery later).
2. **Analyzes each store** from public endpoints: is it Shopify, brand name, country, currency, language, category, product count, price range, last product date, theme, installed apps, socials, and **a contact email** scraped from the site.
3. Lets the user **filter and select** stores in a table.
4. **Sends one email template to the selected stores** from the user's own **Gmail or Outlook** account. Each email is personalized with variables like `{{marka}}` (brand name). Sending is throttled (e.g. 100/hour), and the user starts it with a button.

Target market: **global, but Turkey-first**. Each store gets a `tr_score` (0–100) and the UI favors TR stores by default.

## Hard constraints (product decisions, don't relitigate)

- **100% free.** No paid APIs or services (no StoreLeads/BuiltWith/Hunter/ZeroBounce/SerpAPI, no paid ESPs). Use only public endpoints, free data such as Common Crawl, DNS, and the user's own mailbox.
- **Sending goes only through the user's own free Gmail or Outlook account.**
  - Gmail: SMTP + **App Password** via Nodemailer. We deliberately do **not** use the Gmail API: unverified OAuth apps get refresh tokens that expire every 7 days.
  - Outlook (**personal accounts only**, decided 2026-11-20): OAuth 2.0 auth-code + **PKCE** (public client, no secret) against the `consumers` authority, then **SMTP `smtp-mail.outlook.com:587` with XOAUTH2** (scope `https://outlook.office.com/SMTP.Send`). We use SMTP rather than Graph because Graph cannot set `List-Unsubscribe`. The user registers a free Azure app once ("Personal Microsoft accounts only", platform "Mobile and desktop", redirect `http://localhost:3000/api/oauth/outlook/callback`) and provides the Client ID via `.env` `OUTLOOK_CLIENT_ID` (preferred, read-only in the UI) or pastes it in Settings (kv `outlook_client_id`). The refresh token is stored encrypted as JSON in `accounts.secret`, and every rotated refresh token is persisted. Default daily limit is 150 because Microsoft flags new personal accounts quickly.
- **No cron or scheduled sends.** The user clicks "start" and the worker sends in throttled batches. Pause, resume and stop must work. Respect the account's daily cap (Gmail ~500/day, use ≤400; Outlook ~300/day, use ≤250) and stop automatically when the cap is reached.
- **Spread sends randomly** across the hour (e.g. 100/hour ≈ one every ~36s ± jitter). Never burst.
- **Local-only app.** No auth, no multi-tenant, no deployment target. Credentials live on the user's machine.
- **Emails are plain text** (decided 2026-11-20): no designed HTML templates. A minimal HTML part that mirrors the text is OK, but the email must look hand-written: no images, no tracking pixels, few links.
- **No per-store "findings/audit" personalization for now** (shelved 2026-11-20). An earlier idea was to detect each store's problems (old theme, broken nav links, missing reviews, PageSpeed) and mention one in the email. Don't build it unless the user revives it.
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
  index.ts                  analyzeStore(domain) → AnalysisResult
  http.ts                   fetchPage (UA, timeout, 429 retry, size cap), fetchJson, describeError (TR messages)
  storefront.ts             Shopify detection, meta.json/products.json parsing, theme/apps/socials, computeTrScore
  emails.ts                 email extraction/cleanup/ranking, MX check (cached)
src/lib/jobs.ts           job queue: enqueue / claimJobs (atomic UPDATE…RETURNING) / retry / heartbeat
src/lib/stores.ts         store CRUD, saveAnalysis, contacts logic, filtered queries, facets, stats
src/lib/store-filters.ts  StoreFilters type + URL (de)serialization. Shared client/server, NO db imports
src/lib/format.ts         Turkish display helpers (status labels, country/language names, money, relative time)
src/lib/template.ts       template engine: {{var}} / {{var|fallback}}, renderEmail, htmlToText, DEFAULT_TEMPLATE. Pure, client-safe
src/lib/template-store.ts templates CRUD (+ seeds the user's default plain-text template)
src/lib/accounts.ts       sender accounts (Gmail), sentInLast24h (rolling window)
src/lib/secret.ts         AES-256-GCM for account secrets; key = env APP_SECRET_KEY (64 hex), fallback data/secret.key. Losing it makes saved accounts unreadable
src/lib/env.ts            loadDotEnv(): loads .env.local/.env for worker and scripts (Next loads them itself). Called from src/db/index.ts
src/lib/mailer.ts         Nodemailer: Gmail SMTP (465, app password) and Outlook SMTP (587, XOAUTH2). List-Unsubscribe header, provider-aware classifySendError, DRY-RUN via MAIL_TRANSPORT=json
src/lib/outlook.ts        Microsoft OAuth (PKCE, consumers): authorize URL, code exchange, cached access token + refresh-token rotation, explainMicrosoftError (AADSTS → Turkish fix hints)
src/lib/settings.ts       getSetting/setSetting on kv
src/app/api/oauth/outlook/  start (sets httpOnly state+verifier cookie → Microsoft) and callback (verify state, exchange, SMTP verify, upsert account)
src/lib/campaigns.ts      campaign create (with filtering) / settings / start / pause / stop / retry, preview, tickCampaigns (worker), sendTest
src/lib/suppression.ts    suppression list (never-send); labels in suppression-labels.ts (client-safe)
src/lib/campaign-labels.ts client-safe status labels
src/app/stores/           Stores screen: page (server), filters-bar, stores-table, store-drawer, actions, export/route.ts (CSV)
src/app/templates/        list + [id] editor (live preview, variable chips, content hints, test send)
src/app/campaigns/        list + [id] detail (settings, start/pause/stop, progress, ETA, countdown, preview, recipients)
src/lib/discovery/        F4 discovery: probe.ts (meta.json → shopify/TR/primary domain), ddg.ts (DuckDuckGo HTML + query builder + default TR keywords), commoncrawl.ts (CDX with retries), dns.ts (Shopify IP/CNAME), runs.ts (discovery_runs CRUD), runner.ts (resumable runs, ingest pipeline)
src/app/discover/         discovery screen: 3 source forms + run cards (progress, stats, log, cancel/resume)
src/app/settings/         Gmail accounts (app password + signature), Outlook setup + connect/reconnect, suppression list
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

Store statuses: `pending | analyzing | done | not_shopify | password | unreachable | error`. `done` means a confirmed Shopify store.

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
  - **DuckDuckGo** HTML: `site:myshopify.com <tr keyword>` works well; most results are Turkish Shopify stores. It only serves the first page (10 results): next-page POSTs and `inurl:` queries get 202. Volume therefore comes from keyword × variation queries, spaced 10–16s apart, with backoff on 202 (stops as `blocked` after 3 tries; resumable).
  - Bing, Mojeek and Brave show captchas; don't use them.
  - **Common Crawl** CDX: `pageSize=1` gives ~100 stores per page, but the server often returns 504 (we retry 4× with backoff). Turkish ratio is under 1%, so use it with the TR filter.
  - **DNS**: apex A `23.227.38.*` or www CNAME `*.myshopify.com`.
  - The ingest pipeline: skip known (domain or myshopify_domain) → `probeStore` (meta.json) → TR filter → add by **primary domain**. Analysis marks later twins (same myshopify_domain) as status `duplicate`.
  - Only one active discovery run at a time.
- (original F4 plan, kept for reference):
  - Common Crawl CDX index for `*.myshopify.com`, then resolve the real domain via `/meta.json`
  - Search-engine HTML results (slow, polite)
  - DNS check (Shopify IP `23.227.38.x` / CNAME `shops.myshopify.com`) for bulk domain lists
  - De-duplicate myshopify vs custom domains
- [x] **F5a** Outlook (personal) via OAuth PKCE + SMTP XOAUTH2. Not yet tested against a real Microsoft account. Routes, state checks and error paths were tested with a fake Client ID against the real Microsoft token endpoint.
- [ ] **F5b** IMAP reply/bounce tracking that auto-adds to suppression; follow-up emails

Note: crt.sh is **not** useful for finding stores. Shopify uses a wildcard cert for `*.myshopify.com`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
