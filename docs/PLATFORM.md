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
  - **Not wired yet:** scan jobs still claim through `claimKeyedJob` on the SQLite `scan_jobs` table, single writer per file. Moving scan claiming onto `DbQueue` needs `scan_jobs` on Postgres. That is the next slice, with the yield owners. The other per-process state is listed in the table below.
- **Step 6a (health and error capture):**
  - `GET /api/health/live` answers without touching any store. Use it as the liveness probe.
  - `GET /api/health/ready` and `GET /api/health` are the readiness probe. Each check has a 2 s budget. They return 503 when any of these fails or goes over budget:
    - the store does not answer (Postgres when `DATABASE_URL` is set, else SQLite);
    - on Postgres, `dazl_schema_migrations` is behind the migrations this build ships;
    - the SQLite file the raw-handle modules use does not answer.
  - The budget is a hard cut-off only for asynchronous waits (the Postgres pool). Synchronous better-sqlite3 work (a query, or the first open and migrate) cannot be preempted on the event loop. The probe waits for it, for up to the 5 s busy timeout on a locked file, and then reports that check as `timeout` if it went over budget.
  - The body names the failed check and the engine, never the error text. `/api/health` keeps `ok` and `commit` for `ops/safe_launch.py`.
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
  - Alert hook: with `OPS_ALERT_WEBHOOK_URL` (https only) set, the same scrubbed record is POSTed. It is throttled to one per fingerprint per 10 min and 20 per 10 min overall, fire and forget.
  - Not yet: other diagnostic `console.error` calls inside the scan pipeline (handled per-step failures, not crashes). Also not done yet: the backup restore drill and the deploy checklist (step 6b).
- **Still on SQLite:** every other module. Production keeps running on SQLite until cutover.
- **SQLite-only SQL in queries:** about 18 queries use `rowid` (for example as an ORDER BY tie-break), which PG does not have. They need rewriting as each area is ported.

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
   - `test/tenant-isolation-manifest.ts` classifies all 115 API route handlers: 13 public, each with what authenticates it, and 102 session.
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
   - `test/billing-e2e.test.ts` drives the real routes: checkout, signed webhook, Pro, portal, cancel at period end (still Pro), subscription deleted, Free.
   - The webhook events are Stripe-shaped fixtures (`test/fixtures/stripe/`) signed with a test secret, the same way Stripe signs them.
   - Unsigned, wrongly signed, stale and tampered deliveries are refused. A replay is a duplicate, and an event for another tenant's customer changes nothing.
   - `api.stripe.com` is stubbed: no request leaves the test, and nothing is charged.
   - **Event order (step 5b):** Stripe does not deliver events in order, and `created` is in whole seconds.
     - An ended subscription (deleted, `canceled`, `incomplete_expired`) is recorded in `stripe_ended_subscriptions` and never upgrades the tenant again, whatever the timestamps. A resubscribe is a new subscription id.
     - The end of the tenant's current subscription always downgrades. The end of an older subscription changes nothing.
     - Otherwise `tenant_plans.stripe_event_at` (the `created` time of the last event that set the plan) makes an older event `stale`.
     - A same-second tie between two non-ending states of the current subscription (`active` vs `unpaid`/`past_due`) that would change the plan is settled by the subscription's current status at Stripe, never by delivery order. That status comes from a read-only `GET /v1/subscriptions/:id` made before the transaction.
       - Without that answer (the read failed, or the tie appeared only under the row lock), the tie goes to the restrictive state, Free, at once. `tenant_plans.stripe_reconcile_at` records the unsettled second, and the event is left unprocessed: the webhook answers 503 (`held`).
       - Stripe's redelivery is then settled by the read, whatever the plan reads meanwhile.
       - A delayed `active` never grants Pro without Stripe confirming it.
       - Invoice events (`invoice.paid`, `invoice.payment_failed`) are not handled, and nothing relies on them.
     - The plan row is locked (`FOR UPDATE` on PG) before the checks, so concurrent deliveries follow these rules, not commit order.
     - PG: `0006_stripe_event_order.sql`.
     - Covered by `test/billing-order.test.ts` on both engines: same second, opposite order, resubscribe, ties settled from Stripe's answer, a failed read retried, and concurrent deliveries. It is also covered by signed deliveries through the real webhook in `billing-e2e`, including a tie read from the stubbed Stripe API.
   - **Pricing is inconsistent. This is for the owner to decide, not for code:**
     - The landing page Free card says "3 trial scans, then your own AI key". It does not mention the 50-scans-a-month cap the code enforces (`PLAN_LIMITS.free`).
     - The sign-up page says "Free plan: 50 scans a month with your own AI key. New accounts may get 3 trial scans first".
     - Pro ($49/mo) says "Fair-use limits apply", but the code has no Pro limit (`scansPerMonth: null`), and Settings shows "unlimited".
6. **Ops.** `/api/health` checks the DB and the worker heartbeat. Add a structured error log with an alert hook, a scheduled backup restore drill (extends `scripts/backup/restore-drill.ts`), and a deploy checklist in `web/docs/DEPLOY.md`.

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
   - Copy the cluster with `scripts/pg-migrate/rehearse-full.ts`.
   - Verify counts and checksums.
   - Switch `DATABASE_URL` for all instances at once.
6. **Test that gates step 5.** Two app instances on one Postgres run N stubbed scans:
   - each scan runs exactly once;
   - a killed instance's scan is requeued or failed;
   - leads are written once;
   - tenant isolation holds on every scan route.

The quote, identity and date gates in the scan pipeline do not change in any step. Each step moves storage only.

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
