# Platform inventory and Postgres migration plan

Snapshot of `web/` at df0bee5 (2026-10-27). Goal: run dazl.ai as a multi-tenant SaaS on Postgres with more than one app instance.

## Where we are

- Runtime store is one SQLite file (`DB_PATH`) opened by `getAuthDb()` (`web/lib/auth-db.ts`). Every module uses the synchronous better-sqlite3 API directly: about 600 `.prepare()` calls in 82 files under `web/lib` and `web/app`. There is no async data layer yet.
- Postgres today is a rehearsal path, not a runtime path:
  - `web/scripts/pg-migrate/extract-schema.ts` runs each module's `migrate*()` against a scratch SQLite DB and dumps the schema. `translate-schema.ts` turns that into `schema-full.generated.sql` (60 tables). `rehearse-full.ts` copies synthetic rows into a guarded `dazl_rehearse_*` database and checks them.
  - `web/lib/db/leads-read-pg.ts` is the only Postgres query code: the `LeadsReadDb` read slice, tested for equivalence with pg-mem. No route uses it.
- Tables are created at runtime by each module's `migrate*()` (`CREATE TABLE IF NOT EXISTS` plus `ALTER` in try/catch). There is no versioned migration runner.

## Progress

- **Step 2a:** adds `web/lib/db/client.ts`, an async `Db` with SQLite and PG adapters selected by `DATABASE_URL`, plus versioned PG migrations (`web/lib/db/migrations/pg`, run by `npm run db:migrate`). The 12 SQLite-only tables below are now in the PG schema, so all 72 tables have PG DDL.
- **CI** (`.github/workflows/web-ci.yml`) runs the full suite twice, once on SQLite and once with a Postgres 16 service, and a schema drift check fails when the code's tables and the PG migrations differ.
- **Step 2b (auth + billing on `Db`):** sessions, password sign-in/sign-up, Google sign-in (`users`, `sessions`, `oauth_identities`), and the Stripe webhook, checkout and portal (`tenant_plans`, `stripe_events`) now go through `Db`. They run against both engines in tests (`test/helpers/engines.ts`). Sync readers that other areas still call (`getPlan`, `setPlan`, `scanQuota`, and the seller- and buyer-profile functions in `auth-db.ts`) stay on raw SQLite until those areas are ported.
- **Mixed mode on SQLite:** ported and unported code share one connection. `Db.tx` bodies are generators that can only yield statements. On SQLite, a body runs synchronously inside one better-sqlite3 transaction, so no other request (raw or ported) can run during it, see it half-done or join it. `test/mixed-mode.test.ts` runs concurrent auth/billing transactions, including a rollback, alongside raw requests on one connection.
- **Step 2c (SEO tables on `Db`):**
  - `seo_audits`, `seo_briefs` and `newsjacks` (`lib/seo/audit.ts`, `brief.ts`, `newsjack.ts`, and the `/api/seo/audit`, `/brief` and `/newsjack` routes) now go through `Db`. They live in Postgres when `DATABASE_URL` is set.
  - `test/seo-store.test.ts` runs their write and read paths with two tenants on both engines.
  - The tenant's AI key for briefs and drafts is still read from the SQLite key store until `tenant_llm_keys` is ported.
  - The route-test harness (`test/helpers/tenant-route-db.ts`) points `getDb()` at the same fixture store as `getScanDb()`, as in the app. The route isolation tests therefore also cover the ported routes, and the shared rate limiter writes to that store. The snapshots skip the two global platform tables.
- **Step 3c (shared work queue across instances):** `lib/queue/db.ts` `DbQueue` is the queue contract (`lib/queue/types.ts`) on `Db`, so on Postgres any number of instances share one queue.
  - A claim takes the next fencing token with `UPDATE work_queue_meta … RETURNING`, a row lock held to commit, so claims are serialized across instances and the per-tenant and global in-flight caps count only committed claims. It then selects the item `FOR UPDATE SKIP LOCKED`.
  - `complete` and `fail` match on the claim token: a stale holder changes nothing.
  - A claim whose instance died expires at the end of its lease. It goes back to pending with backoff, or to `failed`/`timeout` past max attempts.
  - `test/multi-instance.test.ts` runs the contract on both engines, then on Postgres:
    - Two instances, as separate processes with their own pools, drain 60 jobs. Each runs exactly once, both take jobs, and one 24h limit is shared across them.
    - An instance killed mid-job loses its claim at lease end. The job runs once more on the survivor, or fails past max attempts.
  - `test/two-instance-scan.test.ts` adds the scan rows the queue schedules, on Postgres, two instances as separate processes. The scan is a stub (no provider, no fetch, no spend); the storage is the real `DbQueue`, the runner's conditional bind (pending to running, attempts + 1) and `store-db.ts`'s fenced `finishJob`:
    - Draining one queue, each of 30 scans is claimed, bound and run once, by both instances. Racing the bind with no queue, each of 40 scans goes to one instance.
    - An instance killed with SIGKILL mid-scan: after the lease and the stale reaper, the other runs it as attempt 2. Each job ends with exactly its leads, none written twice.
    - An attempt that lost its scan (stalled past its lease while the other instance re-ran it) cannot finish it: no leads, no status change, its queue token is stale.
    - Tenant isolation through the real routes (scan history, campaign, export, confirm, quarantine, cancel), one instance per tenant: each sees only its own scans and leads, and every action on the other tenant's ids is a 404 that changes nothing. The SQLite handle is a trap in those processes.
    - Mutation-checked: dropping the bind's `status = 'pending'` guard, or `finishJob`'s attempt fence, fails it.
  - **Scan claiming through the shared queue (`DAZL_SCAN_SHARED_QUEUE=1`, default OFF):** `lib/queue/scan-claimer.ts`. With the flag on, `kickRunner` (`lib/scan/runner.ts`) hands every claim to `kickSharedScanQueue` and returns; off, it runs exactly as before (`claimKeyedJob`, and `DAZL_QUEUE_TENANTS` if set). The flag takes precedence over `DAZL_QUEUE_TENANTS`.
    - Each kick first reaps stale running scans with the legacy reaper's own rule (`reapStaleJobs`): back to pending, or, at the attempt cap (`MAX_ATTEMPTS` = 3), failed as `timeout`, so no path runs a scan a fourth time. It then mirrors the scans the legacy claimer would take (pending, funded by a saved key or the trial: `claimKeyedJob`'s filter) into `work_queue`, keyed by the scan id. While this instance has a free run slot, it claims an item, binds the `scan_jobs` row with the runner's guard (pending only), runs it, and settles the item by claim token. A finished, cancelled or failed scan completes its item without running; a running row (a live attempt) is left alone and its item retried. A scan whose instance died waits out the queue's retry backoff (30 s, then doubling) after its lease before it runs again.
    - Limits: no per-tenant cap beyond the instance's run slots, as with the legacy claimer. The lease is `SCAN_STALE_RUNNING_S` (20 min).
    - **What is shared today:** the queue lives in `getDb()`, so with `DATABASE_URL` set it is on Postgres and shared. The scan rows are still the runner's raw SQLite handle, one file per instance, until the runner's storage port (next step); so until then the flag is for a single instance, and a Postgres instance reports not ready (`checks.split`).
    - **Switching it on (deploy-time, Gagan/Instinct):** set `DAZL_SCAN_SHARED_QUEUE=1` and restart. Pending scans are mirrored on the first kick. Off again: unset and restart; queue items sit inert and the legacy claimer takes the pending rows. Several instances only after the storage port and the production database switch (`docs/PLATFORM.md` "Postgres cutover"), which stays off.
    - Tests: `test/scan-claimer.test.ts` (the claim rules on both engines; `kickRunner` with the flag on and off through the real runner) and `test/two-instance-scan.test.ts` (two processes on Postgres: 30 created scans each mirrored and run once by both instances; a SIGKILLed instance's scan taken over after the lease).
  - **Runner storage port (so instances share real scans; behind `DAZL_SCAN_SHARED_QUEUE`):** `runJob` writes through 25 modules still on the raw SQLite handle plus `runner.ts` itself. Each slice gives those modules async `Db` twins of exactly the functions the runner calls, sharing SQL and logic with the sync versions, which stay for today's runner. A module drops out of `lib/db/pg-port-status.ts` when the runner (last slice) switches to the twins. Order, to keep clear of the yield builder's work in `lib/scan`: non-yield modules first, `lib/scan` modules and `runner.ts` last.
    - Slice 1: `llm/key-store.ts` (`fetchKey`, `readTenantKey`), `connectors/store.ts` (`readEnabledCredential`), `watch.ts` (`writeWatchLeads`), `signals/competitor-reddit.ts` (`gatherCompetitorComplaints`, `writeComplaintBadges`). `memory.ts` already had `readMemory`. Behaviour: `INSERT OR IGNORE` into `watch_seen` became `ON CONFLICT (watch_id, seen_key) DO NOTHING` (only the primary key can conflict), and the Reddit hourly budget counts from the caller's clock instead of SQLite's (the same second). `test/runner-storage-1.test.ts` runs each scenario through the sync function on SQLite and the twin on SQLite and Postgres: identical results and rows, tenant B untouched.
    - Slice 2: `search/tinyfish.ts` (`tfSearch`, `tfFetch`, `tfFetchMany`) and `advanced/index.ts` (`collectAdvanced`) now run on the `Db` layer and take either a `Db` or today's raw handle (`DbLike` / `asDb` in `lib/db/client.ts`: a raw handle is wrapped on that same connection, so the runner is unchanged). TinyFish's caps are checked and recorded in one transaction: synchronous on SQLite, and on Postgres behind a per-day advisory lock, so concurrent calls, from one process or several instances, never pass a cap together (`test/runner-storage-2.test.ts`; without the lock, 12 of 12 calls went through a cap of 5). The advanced connectors' hourly budget counts from the caller's clock. tinyfish leaves the manifest.
    - Next: sitecrawl and people search (they call `recordContactRejection` in `lib/scan/contact-agreement.ts`, so they move with the `lib/scan` slice); outreach autopilot (it calls the outreach service's draft, approve and send storage, so it needs that service's port); then the `lib/scan` modules; then `runner.ts`.
- **Step 6a (health and error capture):**
  - `GET /api/health` and `GET /api/health/live` are the liveness probe: `{ok: true, commit}`, without touching any store, so a slow database never gets a healthy process restarted. (Until step 6b `/api/health` was readiness.)
  - `GET /api/ready` and `GET /api/health/ready` are the readiness probe. `ops/safe_launch.py` and the deploy checklist wait on `/api/ready` (`ok` and the served `commit`) before a cutover. All four are unauthenticated and carry no tenant data.
  - Readiness: Each check has a 2 s budget. They return 503 when any of these fails or goes over budget:
    - the store does not answer (Postgres when `DATABASE_URL` is set, else SQLite);
    - on Postgres, `dazl_schema_migrations` is behind the migrations this build ships;
    - the scan work queue (`work_queue`, `lib/queue`) does not answer in that store;
    - the environment `web/docs/DEPLOY.md` requires is missing or malformed: `DB_PATH`, `DAZL_MASTER_KEY` (exactly what its consumer `getMasterKey` accepts: the value decodes to 32 bytes; decoded-byte compatibility, not strict base64, so readiness never disagrees with the app), `PUBLIC_BASE_URL` (parses as an absolute http(s) URL with a real host, no credentials, query, fragment or whitespace), `STRIPE_SECRET_KEY` (`sk_`/`rk_`), `STRIPE_PRICE_PRO` (`price_`), `STRIPE_WEBHOOK_SECRET` (`whsec_`). The body gives only `checks.env: {ok, missing: <count>}`; the names go to the error reporter when the missing set changes, not on every probe.
    - the SQLite file the raw-handle modules use does not answer.
  - The budget is a hard cut-off only for asynchronous waits (the Postgres pool). Synchronous better-sqlite3 work (a query, or the first open and migrate) cannot be preempted on the event loop. The probe waits for it, for up to the 5 s busy timeout on a locked file, and then reports that check as `timeout` if it went over budget.
  - The body names the failed check and the engine, never the error text. `/api/ready` carries `ok` and `commit` for `ops/safe_launch.py`.
  - Every API route that answers a 5xx from its own `catch` reports the error (`test/route-error-capture.test.ts` reads the route sources and fails on one that does not); the rest rethrow to Next's `onRequestError`. Step 6b added the outreach draft route and the CRM push.
  - Errors are captured by `lib/ops/errors.ts` as one JSON line on stderr. Every field is built in code, scrubbed free text, or checked against its exact shape and replaced when it does not match:
    - `where`: a route template or worker name, never a concrete path.
    - `tenant`: a `users.id`, 32 lowercase hex characters.
    - `ref`: a Stripe event id from a signature-verified webhook, or a scan job id (24 lowercase hex).
    - `method` and `source`: fixed sets.
    - `error.name` and `cause.name`: a class name ending in Error/Exception, or one of the app's own error classes.
    - `message` and stack frames: scrubbed and bounded.
    - Also included: a fingerprint.
    - Scrubbed: emails, auth headers, provider keys, DB URLs, URL queries, IPs, phone numbers and long tokens.
    - Never read from the request: bodies, headers or cookies. The one exception is the session cookie, used only to look up the tenant id.
  - Sources:
    - every uncaught route, page or server-action error (Next `onRequestError` in `instrumentation.ts`, tenant from the session cookie, lookup bounded to 500 ms);
    - the auth, billing and Gmail callback routes' own catches;
    - the tick's per-tenant workers;
    - uncaught process exceptions (monitor only, exit behaviour unchanged);
    - unhandled promise rejections (`lib/ops/process-errors.ts`). Next's own listener keeps the server up. If ours is the only listener, it rethrows after recording, so bare Node still exits;
    - scan runner and queue runner crashes (`lib/scan/crash.ts`). A rejection that escapes `runJob`'s own failure handling is recorded with the tenant and job id. The job is marked `failed` with `error = 'crashed'`, fenced on `status = 'running'` and the same `attempts`, instead of waiting in `running` for the stale-lease reaper. On the queue path the queue item is failed too, not retried, since a crash would repeat.
  - **Request ids and JSON request logs** (`proxy.ts`, `lib/ops/request-log.ts`):
    - Every `/app` and `/api` request gets a fresh random UUIDv4. An incoming `x-request-id` is replaced, never trusted.
    - The id is forwarded to the route as the `x-request-id` request header, returned as a response header, and recorded on error records as `request_id`, so a log line and an error can be joined.
    - Each request writes one JSON line to stdout: `{level, type: 'request', ts, request_id, method, path}`.
      - `path` is the route template the request matches (`lib/ops/routes.ts`, e.g. `/api/leads/[lead]/confirm`). No caller-supplied path text is ever logged, encoded or decoded. A path matching no route logs as `/api/[unknown]` or `/app/[unknown]`. A test fails when the list and the route files under `app/` differ.
      - It never contains headers, cookies, bodies or IPs.
      - Health probes write no line.
    - The proxy runs before the route, so the line has no status or duration. Failures appear as error records carrying the same `request_id`.
    - `middleware.ts` moved to `proxy.ts`: the Next 16 name, Node runtime. The `/app` sign-in redirect is unchanged.
  - Alert hooks, both off unless configured, both throttled to one per fingerprint per 10 min and 20 per 10 min overall, fire and forget:
    - **What leaves the server is an allowlist, not the scrubbed record** (`outboundRecord`, `toSentryEnvelope` in `lib/ops/errors.ts`). The pattern scrub cannot recognise every name, secret or note, so no free text is sent at all.
      - Sent:
        - the error type: a built-in class or one of `APP_ERROR_CLASSES`, else `Error`;
        - up to 8 stack frames, as file, line and column only, with no function names. A file is kept only if it is a code path or a `/_next/static/` URL with its query stripped;
        - the route template, source, method, request id and fingerprint;
        - environment and release.
      - Never sent: messages, causes, the tenant, refs, request bodies, headers, cookies, query strings or other context.
      - No Sentry SDK is loaded, so there are no breadcrumbs, default PII or request data to turn off.
      - The full scrubbed record stays in the server's own stderr log.
      - Tested with an arbitrary name, an email, a token-like string and a free-text lead note placed in the message, the cause, the error name and the stack frames (`test/ops-sentry.test.ts`).
    - `OPS_ALERT_WEBHOOK_URL` (https only): the allowlisted record is POSTed as JSON.
    - `SENTRY_DSN` (https only): the allowlisted record goes as a Sentry event, in an envelope to the DSN's project (`/api/<project>/envelope/`), so Sentry, GlitchTip or a Sentry relay can receive it.
      - Grouping uses the record's fingerprint.
      - `environment` is `SENTRY_ENVIRONMENT` if it is a plain word, else `staging` when `DAZL_ENV=staging`, else `production`.
      - `release` is `DAZL_COMMIT_SHA` when it is a commit sha.
      - Without a DSN, or with one that does not parse, nothing is sent (`test/ops-sentry.test.ts`).
  - Health on both engines: `test/health-routes.test.ts` runs the real `/api/health`, `/api/health/live`, `/api/health/ready` and `/api/ready` handlers on SQLite, on an unreachable Postgres, and (with `DAZL_TEST_PG_URL`) on a Postgres with every shipped migration (store and schema ready; 503 from the `split` check alone while raw-SQLite modules remain) and on one missing the newest (503, schema `behind`).
  - Not yet: other diagnostic `console.error` calls inside the scan pipeline (handled per-step failures, not crashes). Also not done yet: the backup restore drill and the deploy checklist (step 6b).
- **Scan jobs to Postgres, step 1 (platform part):**
  - `lib/scan/store-db.ts` has `Db` versions of the scan job store: create, query-create, get, count-active, list leads, count hidden, latest, list jobs, export, cancel and the stale reaper.
  - `test/scan-store-db.test.ts` covers them with two tenants on both engines, and pins them to `store.ts` on SQLite with the same rows.
  - No caller is switched. `store.ts`, the runner and the routes are unchanged; callers move with their owners.
  - **Step 2, storage half:** `finishJob` and `failOrRequeue` write an attempt's end in one `Db` transaction: leads, review rows, counts and the job row.
    - They are fenced on `status = 'running' AND attempts = ?`, with `FOR UPDATE` on PG.
    - They are tested on both engines: stale attempts write nothing; requeue until `MAX_ATTEMPTS`, then fail.
    - One deliberate difference from the runner's `finish()`: only duplicates are skipped (`ON CONFLICT DO NOTHING`, the same on both engines). A row that fails a CHECK fails the whole attempt instead of being dropped silently, as SQLite's `INSERT OR IGNORE` does.
    - Wiring the runner to them is the yield session's part.
  - Differences from `store.ts`:
    - Times come from the caller.
    - Same-second ties order by `id`, not `rowid`.
    - `getJob` does not reap as a side effect.
- **Tenant isolation of tables on `Db`** (audit of every table a `Db`-layer module reads or writes, both engines):

  | Table | Covered by |
  |---|---|
  | `users`, `sessions`, `oauth_identities` | `test/tenant-isolation-db.test.ts`: sessions, password sign-in, Google sign-in |
  | `tenant_plans`, `stripe_events` | `test/tenant-isolation-db.test.ts` (billing); `billing-e2e` (another tenant's customer changes nothing) |
  | `seo_audits`, `seo_briefs`, `newsjacks` | `test/seo-store.test.ts` |
  | `scan_jobs`, `leads` (via `lib/scan/store-db.ts`) | `test/scan-store-db.test.ts` |
  | `rate_limits` (global table, per-tenant keys) | `test/tenant-isolation-db.test.ts`: one tenant using up its allowance never spends or blocks another's |
  | `app_leases`, `dazl_schema_migrations` | Global, no tenant data (listed in `NOT_DIRECT`) |

  On open branches: `work_queue` is covered in `test/multi-instance.test.ts` (#252). `stripe_ended_subscriptions` (#253) is keyed by Stripe's globally unique subscription id, and its tenant comes from the verified event; a two-tenant test follows once #253 merges.
- **Tenant isolation across instances** (`test/multi-instance-isolation.test.ts`): two app instances (separate processes and pools) share one Postgres.
  - They write tenant A's and tenant B's data concurrently through every `Db`-layer write path:
    - sign-up and sessions;
    - billing;
    - scan jobs and leads;
    - SEO audits, briefs and drafts;
    - the work queue.
  - Then each reads as the tenant the other instance wrote, through every `Db`-layer read, list, export and action path:
    - with its own data, nothing of the other tenant comes back;
    - with the other tenant's ids, it gets nothing and changes nothing (cancel, approve);
    - Stripe calls carry only its own customer;
    - its rate allowance is untouched.
  - No leak was found. A planted leak (`getJob` ignoring the tenant) fails the test.
  - Modules still on raw SQLite (campaigns, most settings, outreach) cannot run on Postgres yet; their routes are covered on SQLite by the route manifest tests.
  - **Concurrently, through the routes** (`test/concurrent-tenant-isolation.test.ts`): two app processes signed in as tenant A and tenant B run at the same time (their timings must overlap) through the real handlers: settings (memory, competitors, enrichment key), LinkedIn connections and warm paths, Cal.com secret and signed bookings, and signed Stripe webhooks with the plan read back. Each round every read must be only its own tenant's, and every attempt on the other tenant (its warm path, a reported path on its lead, a Cal.com booking signed with the wrong tenant's secret) is refused or returns nothing; then every row each tenant owns is checked for the other's data. Removing the warm-path lead-ownership check fails it.
- **Route error records carry the request id**: the auth, billing, Gmail callback and tick catches pass `requestIdOf(req)`, the UUID `proxy.ts` set, as uncaught errors already do (`test/route-errors.test.ts`).
- **Postgres-readiness audit** (`lib/db/sql-audit.ts`, `test/pg-sql-audit.test.ts`): every SQL statement in `lib/` and `app/` is found statically and `PREPARE`d on a freshly migrated Postgres schema, which parses it and resolves every table, column, function and parameter type without running it.
  - At the time of the audit: 786 statements: 76 on `Db`, 18 Postgres-native (`lib/db/leads-read-pg.ts`), the rest raw. Postgres accepts every `Db` and Postgres-native statement; it rejects 86 raw ones.
  - 148 modules still need the synchronous SQLite handle: 87 run raw queries or writes on it, and 61 get it (`getAuthDb`/`getScanDb`) for code that does.
  - Not counted:
    - Modules whose only raw statements are SQLite schema setup (their Postgres side is the PG migrations): `auth-google.ts`, `billing/stripe.ts`, `db/platform-tables.ts`, and the three `seo/` stores.
    - `ENGINE_FILES` (`lib/db/sql-audit.ts`): the `Db` layer's SQLite engine and the cross-engine tooling, which are tested on both engines.
  - The rejected statements are SQLite dialect: `strftime` (28), `INSERT OR IGNORE/REPLACE` (most of the syntax errors), `rowid` (12), `sqlite_master` table checks (9), and a few type-inference or aggregate differences. They are fixed as each module is ported, under both-engine tests, not rewritten in place: on the raw handle they cannot reach Postgres anyway, and an in-place rewrite would change SQLite behaviour (`INSERT OR IGNORE` also swallows NOT NULL and CHECK violations; `ON CONFLICT DO NOTHING` does not).
  - Port order by size (modules / rejected statements): `lib/scan` 31/38 and `app/api/scan` 11 (yield-owned); `lib/outreach` 18/17 and `app/api/outreach` 12/1; `app/api/leads` 16; `app/api/settings` 8; the rest are 1 to 7 modules per area.
  - No schema gap: every table and column the app uses exists in the PG schema.
  - `lib/db/pg-port-status.ts` lists each raw module and how many of its statements Postgres rejects. The test holds the code to it both ways: a new raw module or a newly rejected statement fails, and a port that shrinks it fails until the manifest is regenerated (`scripts/pg-migrate/sql-audit.mts --write`).
  - SQL built at runtime (35 statements) cannot be checked statically. The `Db`-layer ones run on Postgres in the both-engine tests.
- **Postgres port, batch 1 (core customer path):** these routes now run on `Db`, on SQLite and on Postgres:
  - scan history (`/api/scan/jobs`), the last search (`/api/scan/latest`) and cancel (`/api/scan/cancel`), through `lib/scan/store-db.ts`;
  - lead confirm and quarantine, which are writes;
  - the leads CSV export;
  - the campaign page (`/api/campaigns/[id]`);
  - the settings profile, usage (plan quota, billing status, key presence, trial) and the Google sign-in callback.
  - Modules that moved fully: `history-jobs.ts`, `outcome-detail.ts`, `review-confirm.ts`, `campaign-detail.ts`, `best-person.ts`.
  - Modules that keep a sync version for callers still on the raw handle (the scan runner, the send gate, other routes) gained async twins that share their SQL and logic: `auth-db.ts`, `plans.ts`, `llm/key-store.ts`, `scan/trial.ts`, `scan/run-report.ts`, `scan/quarantine.ts`, `search/news-attribution.ts`.
  - **Behaviour on SQLite is unchanged:**
    - Rewritten statements: `strftime('now')` became the caller's clock (the same epoch second); a `sqlite_master` table check became a zero-row probe of the table.
    - Ordering: `rowid` tie-breaks became `insert_seq` (see below), which on SQLite is the order `rowid` gave. Two places that relied on SQLite's implicit insertion order now say `rowid` explicitly: export rows, and enrichments for Best Person.
    - No `INSERT OR IGNORE` was in this batch. The one on the core path that can swallow NOT NULL/CHECK failures is the runner's lead insert (`lib/scan/runner.ts`); `store-db.ts`'s `finishJob` already does not.
  - **Tests:** `test/helpers/pg-port-routes-runtime.mts` runs the real handlers as two tenants:
    - On SQLite, compared with the raw store they replaced, including same-second ties.
    - On SQLite and Postgres from the same seed: every response and every row must be identical.
    - In the Postgres run, `getScanDb()` throws and `DB_PATH` cannot be opened, so a route still reaching for the raw handle fails. (Checked: pointing `/api/scan/latest` back at the raw store fails the run.)
  - **Not in batch 1:**
    - `GET /api/leads`: its read contract spans sequences, connectors, events, priorities and lookalikes, plus the currentness gate's storage.
    - The campaign list: it evaluates the draft, approve and send gates per draft, so those gates' storage moves first.
    - Starting a scan and scan status: they call the runner, which is yield-owned.
- **Postgres port, batch 2 (settings, Cal.com, warm paths):** these routes now run on `Db`:
  - settings: memory, competitors, Cal.com, connectors, enrichment keys, advanced connectors, the LLM key;
  - the Cal.com webhook (`/api/hooks/calcom`);
  - the LinkedIn connections import (`/api/warm/connections`) and a lead's warm paths (`/api/leads/[lead]/warm-path`).
  - Modules that moved fully: `calcom/index.ts`, `llm/key-evidence.ts`, `warm/connections.ts` (all but its SQLite migration).
  - Async twins sharing SQL with the sync version the scan pipeline still uses: `memory.ts`, `signals/competitor-reddit.ts`, `connectors/store.ts`, `advanced/index.ts`, `llm/key-store.ts`.
  - **Behaviour on SQLite is unchanged:**
    - `INSERT OR IGNORE` / `OR REPLACE` became explicit `ON CONFLICT` on the primary key: Cal.com bookings (`DO NOTHING` on the booking uid), user-reported warm paths (`DO NOTHING`), and the connections import, which upserts on `(tenant_id, linkedin_url)` (the last row for a profile URL wins, as `OR REPLACE` did). A row a later repeat replaces is still written first, so the table's CHECKs judge every accepted row: an over-long `connected_on` anywhere in the file still rejects the whole import and leaves the existing connections in place (`test/warm-connections.test.ts`, both engines). None of these was hiding a NOT NULL or CHECK failure.
    - `strftime('now')` became the caller's clock. Unordered reads that SQLite answered in primary-key order now say so (`connectorStatus` by connector, LLM key status by vendor); same-second ties use `insert_seq`.
    - `insert_seq` now covers `connector_audit` and `warm_user_paths` too (SQLite migration; Postgres `0011_insertion_order_more.sql`).
  - **Tests:** `test/helpers/pg-port-routes-2-runtime.mts` runs the real handlers as two tenants on SQLite and on Postgres from one seed: every response and every row the writes leave must be identical (random ids, secrets and clock times compared by identity), tenant B sees none of tenant A's settings, bookings, connections or paths, and the SQLite handle is a trap on Postgres. It caught the `connectorStatus` order.
  - **Not in batch 2:** `GET /api/leads` and the other leads routes. They read through yield-owned `lib/scan` modules (source review, lookalikes, domain review, evidence copies, find-contact, page signals, qualify) and the outreach gates' storage, which their owners port first.
- **Insertion order on both engines (`insert_seq`):**
  - What it fixes: SQLite's `rowid` gave `scan_jobs`, `leads`, `outreach_messages` and `lead_enrichments` an implicit insertion order, which same-second ties relied on. Postgres has none.
  - `insert_seq` makes that order a column on both engines:
    - **SQLite** (`lib/db/insertion-order.ts`, called by each table's own migration (`migrateScan`, `migrateOutreach`, `migrateConnectors`, `migrateWarm`) and once more at the end of `migrateAllSqlite` and `getScanDb`): existing rows are backfilled from `rowid`. An AFTER INSERT trigger then gives each new row `max(insert_seq) + 1`. Using max rather than `rowid` keeps the order increasing after a copy back from Postgres. A row that brings its own value keeps it.
    - **Postgres** (`0010_insertion_order.sql`): a sequence default. `translate-schema.ts` maps the SQLite trigger to it, so the drift test holds.
  - The ported queries (`store-db.ts`, `campaign-detail.ts`, `best-person.ts`) order ties by `insert_seq` on both engines, and the insertion-order gap list is gone.
  - A `rowid` left in `Db`-layer SQL fails the audit, because Postgres rejects it in `PREPARE`.
  - `copyStore` moves every column sequence past the copied values: `insert_seq`, and the identity ids of `INTEGER PRIMARY KEY` tables. Before this, the first insert after a copy would have reused an id.
  - **Tests:**
    - `test/insertion-order.test.ts`: on an existing store, the migration backfills from `rowid`, re-runs change nothing, and new and copied rows order correctly.
    - The parity runtime: ties seeded out of id order come back identically on SQLite and Postgres.
    - `test/copy-store.test.ts`: the sequences continue past the copied values.
- **Still on SQLite:** the 122 modules in `lib/db/pg-port-status.ts`, down from 135 after batch 1 and 149 before it (the audit's 148 plus `lib/scan/sales-hiring-gate.ts` from #276). Postgres rejects 74 of their statements, down from 83 and 87. Production keeps running on SQLite until that list is empty and the cutover below is authorized.

## Tables (73 created in code)

Legend:
- **PG-schema**: the table is in `schema-full.generated.sql`, and its rows are copied by the rehearsal. At runtime it still lives in SQLite.
- **SQLite-only**: the table has no Postgres DDL because its `migrate*()` is not called by `extract-schema.ts`.

No table is read or written in Postgres at runtime yet.

| Area | Tables | Status |
|---|---|---|
| Auth | users, sessions, oauth_identities | PG-schema |
| Billing / plans | tenant_plans, stripe_events, trial_scans | PG-schema |
| Scan core | scan_jobs, leads, lead_sources, scan_source_runs, csv_batches, csv_rows, commenter_batches, commenter_rows | PG-schema |
| Scan extras | lead_evidence_copies, evidence_purge_audit, evidence_purge_gate (`scan/evidence-copies.ts`); lead_qualifications (`scan/qualify-run.ts`); scan_model_calls (`scan/model-usage.ts`); scan_source_stats (`search/trace.ts`); source_reviews (`scan/source-review.ts`); hiring_feed_crawl (`scan/job-feed.ts`) | **SQLite-only** |
| People | email_patterns, email_candidates (`people/email-pattern.ts`) | **SQLite-only** |
| Queue | work_queue, work_queue_meta (`queue/sqlite.ts`, behind a tenant flag) | **SQLite-only** |
| Temp | leads_new (built and renamed inside `migrateScan` when it widens `leads`) | Not a real table; skip it |
| Events / signals | company_events, tenant_competitors | PG-schema |
| Outreach | outreach_messages, outreach_settings, outreach_llm_usage, outreach_signal_context, gmail_accounts, oauth_states, suppressions, consent_ledger, sequences, sequence_steps, sequence_settings, followup_threads, followup_messages, inbound_messages, mail_read_consent, reopen_messages, autopilot_settings, autopilot_audit | PG-schema |
| Replies | reply_threads, reply_queries, reply_drafts | PG-schema |
| Connectors / warm | tenant_connectors, connector_audit, lead_enrichments, tenant_connections, warm_user_paths, calcom_bookings, calcom_hooks | PG-schema |
| Keys / memory / advanced | tenant_llm_keys, tenant_memory, advanced_consent | PG-schema |
| Monitors / watch | monitors, monitor_runs, monitor_seen, watches, watch_seen | PG-schema |
| SEO | seo_audits, seo_briefs, newsjacks, seo_index_configs, seo_index_keywords, seo_index_results, seo_index_runs | PG-schema |
| Usage | tinyfish_usage | PG-schema |

Totals: 60 PG-schema, 12 SQLite-only, 1 temp.

## In-memory state (lost on restart, not shared between instances)

| Store | File | Effect with 2+ instances | Target |
|---|---|---|---|
| Rate-limit buckets | `lib/rate-limit.ts` (45 callers) | **Done (step 3a):** the `rate_limits` table, one atomic upsert per check, shared by all instances and kept across restarts. A per-process shadow tracks the shared count and the calls it had to decide alone while the store could not answer (read-only, full, locked, unreachable), so an outage, a recovery or flipping between them never hands back a used allowance | During an outage each instance enforces the limit only on the traffic it sees |
| Per-owner spend pool | `lib/llm/spend-guard.ts` `ownerPool` | The budget resets on restart, and each instance has its own copy (overspend) | PG row per owner with an atomic reserve |
| Scan concurrency slots | `lib/scan/run-slots.ts` | `SCAN_MAX_CONCURRENT` applies per instance | Global count of running jobs in PG |
| Scan runner loop and claiming | `lib/scan/runner.ts` `kickRunner`, `claimKeyedJob`, `reapStaleJobs` | Claim is durable today (see below). Gap: on PG a racing loser gets `null` and stops its loop instead of taking the next job; the stale reaper runs on every instance | `FOR UPDATE SKIP LOCKED` claim; keep the conditional `attempts` fence |
| Shutdown requeue | `instrumentation.ts` → `scan/shutdown-hook.ts` | Must requeue only this instance's jobs | Tag each claim with an instance id |
| Tick scheduler | `POST /api/internal/tick` (external cron) | **Done (step 3b): fenced.** The tick holds the `internal-tick` lease, and an overlapping tick returns `skipped`. Each takeover bumps the lease's `generation` (the fencing token). All the tick's writes go through `lease.fenceSqlite()`, which checks ownership, generation and expiry in the same transaction as the write. A tick that lost its lease (paused, cut off, expired) has every later write through that view refused (`StaleLeaseWrite`) and stops. That includes bound and fluent statements and `statement.database`. On PG the check locks the lease row, so a takeover waits for a fenced transaction in flight | Not fenced: (1) code that fetches the raw handle itself instead of using the view (the tick's modules only read that way); (2) an email Gmail accepted between a fenced claim and a fenced result, which relies on the outreach claim -> send -> uncertain handling |
| Reopen resolve guard | `lib/outreach/reopen.ts` `inFlight` Set | The send claim is durable (see below). The Set only stops a user resolving a claim older than the lease while the Gmail call still runs in *this* process; another instance cannot see it. Bounded by the 20s Gmail abort vs the 10 min lease | Record the in-flight call in the row, or accept with the lease bound documented |
| TinyFish minute window and breaker | `lib/search/tinyfish.ts` | Provider limit is exceeded N times | PG window row (daily usage is already in `tinyfish_usage`) |
| News request queue | `lib/search/news.ts` | Requests are spaced per instance only | Accept this, or use a PG advisory lock |
| Per-host crawl spacing | `lib/connectors/sitecrawl.ts` `lastHit` | Politeness spacing is per instance | Accept this (best effort) |
| Source result caches | `lib/sources/{youtube,jina,github,v2ex}.ts` | Cache is per instance | Fine to keep |
| Migration-ran flags | `lib/scan/service.ts` `ready`, and similar | None, once migrations run on deploy | Remove after step 2 |
| In-flight scan set and deadlines | `lib/scan/runner.ts` `trackInFlight`, `jobDeadlines` | Only this instance's own runs (used for shutdown requeue and the per-job time budget) | Fine per instance; the claim itself is the shared state |
| Shared store handles | `lib/db/client.ts` `shared`, `lib/auth-db.ts` `db` | One pool or handle per instance | Fine |
| Error sinks and alert throttle | `lib/ops/errors.ts` `sinks`, `hook` | Alert throttling is per instance (up to N× the alert rate) | Accept, or a shared throttle row if alerts get noisy |
| Sessions, plans, 24h send counts | `sessions`, `tenant_plans`, `autopilot_audit` tables | Already durable rows: shared once the table is on the shared store | Port with their areas |

### Existing durable guards (keep them; PG must preserve these semantics)

- **Scan claim** (`claimKeyedJob`): an IMMEDIATE transaction selects the oldest pending job, then `UPDATE … SET status='running', attempts=attempts+1 WHERE id=? AND status='pending'`. It succeeds only when exactly one row changes. Late results are fenced by `attempts`. Under PG READ COMMITTED the conditional UPDATE still lets only one claimer win.
- **Sequence steps** (`lib/outreach/sequences.ts`): `approved → sending` is a conditional UPDATE. The scheduler never skips past a step that is in flight or uncertain. A step stuck in `sending` past the lease becomes `uncertain`, and any uncertain send pauses the tenant's autopilot. Resolving an uncertain step is a manual action that never resends.
- **Follow-ups** (`lib/outreach/followups.ts`): the claim is `INSERT OR IGNORE` of a `sending` row keyed by (tenant, thread, step). An unknown outcome becomes `uncertain` and pauses the tenant.
- **Reopen sends**: `draft → approved` is claimed in an IMMEDIATE transaction together with the lead gates. A throw after the claim leaves the claim in place and never resends. Completion is fenced by the claim time.
- Send approval, the shared 24h cap, suppression, consent and recipient gates all run before these claims. Nothing in this plan removes or reorders them.

These give **at most one send attempt per claim, with no blind resend**. They cannot give exactly-once *delivery*: a crash after Gmail accepts the mail and before the DB records it leaves an `uncertain` row that needs reconciliation. Without provider-side idempotency, no DB lock closes that gap.

## Migration plan (proposed staged development, one PR per step, at most 2 open at a time)

These steps are development work behind flags and tests. Merging them does not change production. Cutover is gated separately, see below.

1. **This doc.**
2. **Postgres as the real store.**
   - Add an async `Db` interface (`query`/`get`/`all`/`run`/`tx`) with SQLite and PG adapters. Select the adapter with `DATABASE_URL`; SQLite stays the default.
   - Move modules to it one area at a time, without changing behaviour. This is the bulk of the work: around 600 call sites change from sync to async.
   - Add the 12 SQLite-only tables to `extract-schema.ts` first, so the PG DDL covers every table.
   - Replace the ad-hoc `migrate*()` functions with numbered SQL migrations that run on deploy. PG uses an advisory lock so only one instance migrates.
   - CI: run the test suite twice, once on SQLite and once on a `postgres:16` service container.
   - Watch for SQL dialect differences: `?` vs `$n` parameters, `strftime`/`unixepoch`, `INSERT OR IGNORE`/`ON CONFLICT`, int8 values coming back as strings (see `leads-read-pg.ts` `num()`), and FTS (none found yet).
   - Given the size, this step will probably need several PRs (adapter and CI first, then areas).
3. **Shared state.** Move the in-memory table above to PG as listed. Tests with two app processes on one PG database:
   - Each scan job has at most one active claim, and no job is run twice for the same `attempts`.
   - Send paths are tested with crash injection at three points: before the provider call, after provider acceptance but before the DB ack, and after the ack. The tests check:
     - there is never more than one active claim;
     - an unknown outcome is never blindly resent;
     - an unknown outcome leaves a durable `uncertain` row and pauses the tenant;
     - reconciliation is an explicit action.
   - Overlapping ticks do no duplicate non-send work (reply sync, monitor queueing, index checks).
   - All sends use stub providers. No real mail is sent.
   - The approval, cap, suppression and consent gates stay as they are.
4. **Tenant isolation.** Step 4a/4b:
   - `test/tenant-isolation-manifest.ts` classifies all 116 API route handlers: 14 public, each with what authenticates it, and 102 session.
   - CI proves that every session handler refuses an unauthenticated caller without changing data.
   - All 102 session handlers are exercised with two tenants:
     - 48 that take ids or list tenant data have targeted tests: tenant B with tenant A's ids gets nothing of A's and changes nothing.
       - 45 of them also have a same-action positive control for A, so a handler that always refused would fail.
       - Not yet verified on the positive side: `POST /api/leads/[lead]/domain-review`, `GET /api/leads/evidence` and `POST /api/scan/csv/[batch]`. Their tenant-B refusals are tested, but a handler that always refused would still pass.
     - The other 54 (no caller-supplied ids) are swept as tenant B with A's data seeded. The sweep sends each entry point an empty body and accepts any status, so it shows no A data leaves and no A row changes on that input. It does not cover every branch.
     - No `pending` handler is left, and the manifest test keeps it at zero.
   - On both engines, every table must have a tenant column, a tenant-scoped parent, or a stated reason to be global.
   - The ported modules (sessions, sign-in, Google sign-in, billing) are tested with two tenants on SQLite and PG.
   - Route-level tests run on SQLite until each area is ported to `Db`.
5. **Stripe e2e (test mode).** Step 5:
   - **Configuration (environment only; no key is ever in code or the repo):**
     - `STRIPE_SECRET_KEY`: `sk_test_...` in test mode (`sk_live_...` only when the owner goes live). Used server-side for Checkout, the billing portal and the read-only subscription lookup on a same-second tie.
     - `STRIPE_PRICE_PRO`: the Pro price id from the Stripe dashboard.
     - `STRIPE_WEBHOOK_SECRET`: the endpoint's `whsec_...` signing secret. Without it the webhook answers 503 and nothing is applied.
     - `PUBLIC_BASE_URL`: where Checkout and the portal return (`/app/settings`).
     - Webhook URL: `https://<host>/api/stripe` or `https://<host>/api/billing/webhook` (the same handler). Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
   - **Unknown tenant (step 5f):** a verified event whose session or subscription names no tenant, for a customer no tenant has, answers 200 (`ignored`), changes no plan, records the event id (so its replay is a no-op), and writes one JSON line to stdout: `{level: 'warn', type: 'stripe_event', event_id, event_type, result: 'ignored', reason: 'unknown_tenant'}`, the id and type shape-checked, never a customer, email or amount. `test/stripe-endpoint.test.ts` runs the whole path through `/api/stripe` on SQLite and Postgres: checkout carries the tenant, bad signatures refused, apply, replay, payment failed, downgrade (`unpaid`), cancel, the unknown-tenant case, and a second tenant's row unchanged at every step.
   - `test/billing-e2e.test.ts` drives the real routes: checkout, signed webhook, Pro, portal, cancel at period end (still Pro), subscription deleted, Free. The same scenario runs on SQLite and on Postgres (the cutover target); on Postgres the raw SQLite handle is a trap, so every step goes through `Db`.
   - The webhook events are Stripe-shaped fixtures (`test/fixtures/stripe/`) signed with a test secret, the same way Stripe signs them.
   - Unsigned, wrongly signed, stale and tampered deliveries are refused. A replay is a duplicate, and an event for another tenant's customer changes nothing.
   - `api.stripe.com` is stubbed: no request leaves the test, and nothing is charged.
   - **Event order (step 5b):** Stripe does not deliver events in order, and `created` is in whole seconds.
     - An ended subscription (deleted, `canceled`, `incomplete_expired`) is recorded in `stripe_ended_subscriptions` and never upgrades the tenant again, whatever the timestamps. A resubscribe is a new subscription id.
     - The end of the tenant's current subscription always downgrades. The end of an older subscription changes nothing.
     - Otherwise `tenant_plans.stripe_event_at` (the `created` time of the last event that set the plan) makes an older event `stale`.
     - A same-second tie between two non-ending states of the current subscription (`active` vs `unpaid`/`past_due`) that would change the plan is settled by the subscription's current status at Stripe, never by delivery order. That status comes from a read-only `GET /v1/subscriptions/:id` made before the transaction.
       - Status policy:
         - Pro: `active`, `trialing`, `past_due`.
         - Free, ended for good: `canceled`, `incomplete_expired`.
         - Free, can recover: `unpaid`, `incomplete`, `paused`.
         - Anything else is unknown and never proof of Pro.
       - Without a usable answer (the read failed, Stripe returned an unknown status, or the tie appeared only under the row lock), the tie goes to the restrictive state, Free, at once. `tenant_plans.stripe_reconcile_at` records the unsettled second, and the event is left unprocessed: the webhook answers 503 (`held`).
       - Stripe's redelivery is then settled by the read, whatever the plan reads meanwhile.
       - A delayed `active` never grants Pro without Stripe confirming it.
       - `invoice.payment_failed` (step 5d) marks the tenant's current subscription `past_due` while it is Pro, so the billing status says so even when Stripe's `subscription.updated` is late. It never changes the plan: a failed payment never grants Pro, and Stripe giving up arrives as `subscription.updated` (`unpaid`) or `deleted`. An invoice of another or an ended subscription is `ignored`/`stale`, as is one created before the event that last set the plan. Both invoice shapes are read: `subscription` at the top level, and `parent.subscription_details.subscription` (API 2025-03-31 and later). `invoice.paid` is not handled; `subscription.updated` carries the recovery.
     - The plan row is locked (`FOR UPDATE` on PG) before the checks, so concurrent deliveries follow these rules, not commit order.
     - PG: `0007_stripe_event_order.sql`.
   - **Plan limits and billing status (step 5c):**
     - `tenant_plans.subscription_status` (PG `0009_subscription_status.sql`) keeps the status Stripe last reported, and `/api/usage` returns it as `billing_status`.
       - Checkout gives `active`.
       - A failed payment gives `past_due` while Stripe retries. The plan stays Pro.
       - A settled tie stores Stripe's answer, and a stale event never rewrites it.
     - `test/billing-limits.test.ts` runs the real routes, signed fixtures and stubbed Stripe, through to the limit on the next scan:
       1. Free at its limit: `/api/scan` returns 402.
       2. Checkout webhook: Pro, and the next scan is accepted.
       3. Failed payment: `past_due`, still Pro.
       4. Subscription deleted: Free, `canceled`, and the next scan returns 402.
     - The scan runner is never started in that test.
     - `test/billing-events.test.ts` (step 5d) drives the webhook route with two tenants on both engines: checkout, `invoice.payment_failed`, recovery, `unpaid`, `deleted`. After each event it checks the plan, limit and billing status, and that the other tenant's row is byte for byte unchanged, both ways. It also checks that unsigned and wrongly signed deliveries are refused, that replays are duplicates, that one event delivered five times at once is applied once, and that stale, crossed and ended-subscription invoices change nothing.
     - Covered by `test/billing-order.test.ts` on both engines: same second, opposite order, resubscribe, ties settled from Stripe's answer, a failed read retried, and concurrent deliveries. It is also covered by signed deliveries through the real webhook in `billing-e2e`, including a tie read from the stubbed Stripe API.
   - **Plan gates read the shared store (step 5e):** the scan routes enforce the plan the Stripe webhook writes, read from `getDb()` (Postgres when `DATABASE_URL` is set): the monthly quota on `/api/scan` and the Pro-only gate on `/api/scan/csv`, `/api/scan/csv/[batch]` and `/api/scan/commenters` (`readPlan`). The monthly scan count still comes from the store those routes write scans to (`planQuota(plan, scansThisMonth(raw))`), so a split store can never count zero and lift a Free limit. On SQLite both are the same connection. `test/billing-plan-gates.test.ts`: checkout, payment failed and cancellation through signed webhooks, with the routes' own store holding the opposite (stale) plan at every step, on a separate SQLite store and on Postgres. Still on the raw handle: `queuePendingRows`' per-row quota (`lib/scan/csv-import.ts`, yield-owned), monitors and watches (`lib/monitors.ts`, `lib/watch.ts` `runDueWatches`, cron).
   - **Pricing is inconsistent. This is for the owner to decide, not for code:**
     - The landing page Free card says "3 trial scans, then your own AI key". It does not mention the 50-scans-a-month cap the code enforces (`PLAN_LIMITS.free`).
     - The sign-up page says "Free plan: 50 scans a month with your own AI key. New accounts may get 3 trial scans first".
     - Pro ($49/mo) says "Fair-use limits apply", but the code has no Pro limit (`scansPerMonth: null`), and Settings shows "unlimited".
6. **Ops.** `/api/ready` checks the store, its schema and the scan queue; `/api/health` is liveness. Add a structured error log with an alert hook, a scheduled backup restore drill (extends `scripts/backup/restore-drill.ts`), and a deploy checklist in `web/docs/DEPLOY.md`.

## Plan: scan jobs to Postgres (for coordination with the yield session; no code yet)

`scan_jobs` is the hub of the scan pipeline. 53 files read or write it: 23 in `lib/scan`, 11 in `lib/outreach`, plus search, people, warm, connectors and Cal.com. That is about 120 statements, 54 of them joins (leads → `scan_jobs.user_id` is how lead rows are tenant-scoped). `leads`, `lead_sources`, `scan_source_runs`, `scan_source_stats`, `scan_model_calls`, `csv_batches` and `commenter_batches` reference it by foreign key. They form one cluster and must move to Postgres together: a join cannot span SQLite and Postgres.

Steps, one small PR each. Nothing changes where the rows live until step 5.
1. **Read and write functions on `Db`, still on SQLite.**
   - Port `lib/scan/store.ts` (create, get, list, cancel, export, reap) to `Db`, with two-engine tests.
   - Keep sync wrappers for callers not yet ported, as was done for `getPlan` and `setPlan`.
   - Platform owns this; the yield session reviews the signatures.
2. **`finish()` and `failOrRetry` as `Db.tx` generators.**
   - The leads insert, the source-run ledger and the job row update stay one transaction.
   - They stay fenced on `status = 'running' AND attempts = ?`.
   - Yield owns this, because it is runner code. Platform pairs on the transaction shape.
3. **Claiming on Postgres.**
   - `claimKeyedJob` becomes a `FOR UPDATE SKIP LOCKED` claim on `scan_jobs`. A loser takes the next job instead of stopping its loop.
   - Alternatively the queue bridge moves onto `DbQueue` (step 3c). It already binds queue claims to domain rows by id and attempts.
   - Add a `claimed_by` instance id, so shutdown requeue returns only this instance's jobs.
   - `SCAN_MAX_CONCURRENT` becomes a global count of running rows (replacing `run-slots.ts`).
   - The stale reaper becomes the lease expiry. Requeue or fail stays bounded by `MAX_ATTEMPTS`.
4. **The other readers.** Outreach, people, warm and the rest move their `scan_jobs` and `leads` joins to `Db`, each with its owning session. Until every reader of the cluster is on `Db`, `DATABASE_URL` must not be set in production. Mixed mode is safe only on SQLite.
5. **Cutover**, owner-authorized (see "Production go/no-go" below):
   - Copy with `scripts/pg-cutover.mts copy` (see "Postgres cutover" below; `rehearse-full.ts` stays the synthetic full-schema rehearsal).
   - Verify counts and checksums.
   - Switch `DATABASE_URL` for all instances at once.
6. **Test that gates step 5.** Two app instances on one Postgres run N stubbed scans:
   - each scan runs exactly once;
   - a killed instance's scan is requeued or failed;
   - leads are written once;
   - tenant isolation holds on every scan route.

The quote, identity and date gates in the scan pipeline do not change in any step. Each step moves storage only.

## Postgres cutover (plan; Instinct decides and deploys)

Nothing here has been run against production. The tool and the steps are ready for a rehearsal; the switch itself is Instinct's call.

**Gate.** `lib/db/pg-port-status.ts` must be empty. A module on the raw SQLite handle keeps reading and writing the SQLite file whatever `DATABASE_URL` says. With the list non-empty, a cutover would split the data between two stores. `scripts/pg-cutover.mts` refuses to copy into Postgres while the list is non-empty, unless `--rehearsal` is passed.

**Verify which store an instance serves from.** `/api/ready` (and `/api/health/ready`), unauthenticated, returns:
- `store`:
  - `engine`: `sqlite` or `pg`;
  - `migrations.shipped`: the highest PG migration this build ships;
  - `migrations.applied`: the highest recorded in the store, or null on SQLite;
  - `raw_sqlite_modules`: the count from `lib/db/pg-port-status.ts`.
- `checks.split`: on Postgres it fails, making readiness answer 503, while any raw-SQLite module remains. Those modules would keep using the SQLite file, so an instance that reports `pg` and is ready has no split data. On SQLite it is skipped, because everything is in one file.

**Tool.** `scripts/pg-cutover.mts` (library: `lib/db/copy-store.ts`; tests: `test/copy-store.test.ts`, `test/pg-cutover-cli.test.ts`).
- `plan --from <app.db> [--to $DATABASE_URL] [--tenants]` is the dry run and writes nothing. It prints:
  - every table's row count, with the number of tenants (or with `--tenants`, each tenant's count);
  - the target's state: not migrated, empty, already holding exactly these rows, or holding other rows (copy would refuse);
  - whether the cutover gate is open.
- `copy --from <app.db> --to $DATABASE_URL` migrates the target, then copies every table in one target transaction:
  - The source is opened read-only.
  - It refuses a source table or column the target lacks.
  - Rows go in parents first. The guard triggers are off only inside that transaction, so a finished job's leads can be copied, and they are back on at commit.
  - Before commit, every table's row count and full-content SHA-256 are compared with the source. Any difference rolls everything back, so the target is either a verified copy or untouched.
  - The queue's fencing-token counter and every column sequence (identity ids, `insert_seq`) continue after the copied values.
  - **Idempotent:** re-run after it finished, it finds exactly the source's rows, reports "already copied" and writes nothing. A target holding anything else is refused.
  - Refused while the gate is closed, unless `--rehearsal` is passed.
- `verify --from … --to …` compares row counts and content checksums table by table. Where counts differ, it names the tenants whose counts differ.
- `rollback --from $DATABASE_URL --to <new.db>` copies Postgres back into a new SQLite file and verifies it. It never writes over an existing file.
- Exit codes: 0 done or matching, 1 stores differ, 2 usage, 3 refused.

**Cutover steps** (one maintenance window, once the gate is open):
1. Take a fresh backup of the SQLite file and restore-test it.
2. Provision Postgres, then run `pg-cutover.mts plan --from <app.db> --to $DATABASE_URL --tenants` and keep the output.
3. Stop every writer: all app instances, plus `worker/`, `session-worker/` and the Hermes tunnel (the write fence does not cover them).
4. `pg-cutover.mts copy --from <app.db> --to $DATABASE_URL`: it migrates, copies and verifies.
5. `pg-cutover.mts verify --from <app.db> --to $DATABASE_URL` must exit 0 ("stores match").
6. Set `DATABASE_URL` on every instance and start them. `/api/ready` must answer 200 with `store.engine: "pg"`, `migrations.applied` equal to `migrations.shipped`, and `checks.split.ok: true`.
7. Keep the SQLite file read-only and untouched. Never delete it.

**Rollback:**
- **Before any write lands on Postgres** (the copy failed, verify differs, or readiness fails): stop the instances, unset `DATABASE_URL`, start again. The SQLite file is exactly as it was.
- **After Postgres has taken writes:**
  1. Stop every writer.
  2. `pg-cutover.mts rollback --from $DATABASE_URL --to <new.db>` writes a new, verified SQLite file.
  3. Point `DB_PATH` at the new file, unset `DATABASE_URL`, and start the instances. `/api/ready` must report `store.engine: "sqlite"`.
  4. Keep the pre-cutover file as a second copy.
- Both directions are covered by `test/copy-store.test.ts` and `test/pg-cutover-cli.test.ts`. The CLI test also writes to Postgres after the copy and checks that the rollback carries the write back.

**Still blocking the switch:**
- 122 modules on the raw SQLite handle (`lib/db/pg-port-status.ts`): the gate. The largest groups:
  - the scan runner and pipeline (`lib/scan`, yield-owned);
  - outreach and the send gates (`lib/outreach`);
  - the leads routes, including `GET /api/leads` (they wait on `lib/scan` and `lib/outreach` storage).
  - Settings moved in batch 2.
- Not authorized: provisioning production Postgres, setting `DATABASE_URL`, and the cutover itself (see "Production go/no-go").
- The write fence is not wired into the app. Writers are stopped by stopping the processes, and the Hermes tunnel and workers must be paused separately.
- 35 runtime-built SQL statements are not statically checked; the ported ones run on Postgres in tests.

**Limits:**
- Each table is read into memory whole, which is fine at today's store size.
- The copy needs downtime: there is no live replication.
- The SQLite file is not encrypted on disk, and neither is the copy.

## Production go/no-go (separate from merging the PRs above)

Each item below needs **its own explicit owner authorization**. Merging a step's PR or approving this doc authorizes none of them:
- setting `DATABASE_URL` in production, provisioning new infrastructure (PG instance, replicas), or any new billing or spend;
- the cutover itself.

Every one of these must hold before cutover:
- **Full rehearsal:** PG DDL covers all tables (the 12 SQLite-only tables included), and the full rehearsal passes on synthetic data.
- **All writers paused or fenced:** the app write fence, plus `worker/`, `session-worker/` and the Hermes tunnel, which the fence does not cover.
- **Backup verified:** a fresh backup, taken and restored by the restore drill.
- **Data checked after copy:** per-tenant row counts and content checksums, SQLite against PG.
- **Rollback ready:** a written rollback plan, including how to handle data that diverges if writes landed on PG before rollback. The SQLite file stays read-only and untouched, and is never deleted.
- **Disk floor:** the live DB plus two rollback copies kept, and the host has room for them.

## Out of scope here
`worker/` and `session-worker/` (Hermes side, separate stores) and the external Hermes tunnel writes. The write fence (`lib/write-fence.ts`) does not cover these, so the cutover runbook must pause them separately.
