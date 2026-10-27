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
| Rate-limit buckets | `lib/rate-limit.ts` (46 callers) | Each instance has its own limit, so the real limit is N times higher | PG table, fixed window, upsert |
| Per-owner spend pool | `lib/llm/spend-guard.ts` `ownerPool` | The budget resets on restart, and each instance has its own copy (overspend) | PG row per owner with an atomic reserve |
| Scan concurrency slots | `lib/scan/run-slots.ts` | `SCAN_MAX_CONCURRENT` applies per instance | Global count of running jobs in PG |
| Scan runner loop and claiming | `lib/scan/runner.ts` `kickRunner`, `claimKeyedJob`, `reapStaleJobs` | Claim is durable today (see below). Gap: on PG a racing loser gets `null` and stops its loop instead of taking the next job; the stale reaper runs on every instance | `FOR UPDATE SKIP LOCKED` claim; keep the conditional `attempts` fence |
| Shutdown requeue | `instrumentation.ts` → `scan/shutdown-hook.ts` | Must requeue only this instance's jobs | Tag each claim with an instance id |
| Tick scheduler | `POST /api/internal/tick` (external cron) | Sends are already guarded by durable per-row claims (see below). Not proven safe: duplicate non-send work in overlapping ticks (reply sync, monitor/watch queueing, index checks that use TinyFish allowance) | `pg_try_advisory_lock` per tick as defense in depth; prove the non-send paths in step 3 |
| Reopen resolve guard | `lib/outreach/reopen.ts` `inFlight` Set | The send claim is durable (see below). The Set only stops a user resolving a claim older than the lease while the Gmail call still runs in *this* process; another instance cannot see it. Bounded by the 20s Gmail abort vs the 10 min lease | Record the in-flight call in the row, or accept with the lease bound documented |
| TinyFish minute window and breaker | `lib/search/tinyfish.ts` | Provider limit is exceeded N times | PG window row (daily usage is already in `tinyfish_usage`) |
| News request queue | `lib/search/news.ts` | Requests are spaced per instance only | Accept this, or use a PG advisory lock |
| Per-host crawl spacing | `lib/connectors/sitecrawl.ts` `lastHit` | Politeness spacing is per instance | Accept this (best effort) |
| Source result caches | `lib/sources/{youtube,jina,github,v2ex}.ts` | Cache is per instance | Fine to keep |
| Migration-ran flags | `lib/scan/service.ts` `ready`, and similar | None, once migrations run on deploy | Remove after step 2 |

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
   - `test/tenant-isolation-manifest.ts` classifies all 113 API route handlers: 11 public, each with what authenticates it, and 102 session.
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
5. **Stripe e2e (test mode).** Use signed fixture events with `STRIPE_WEBHOOK_SECRET`, covering checkout → upgrade → portal → cancel → downgrade. The PR only tests plan transitions. Prices and plan terms are an **owner decision**, not something to settle in code. Open question for the owner: Free gives 50 BYOK scans a month, but the site says "3 trial scans then BYOK", and Pro ($49) says "unlimited".
6. **Ops.** `/api/health` checks the DB and the worker heartbeat. Add a structured error log with an alert hook, a scheduled backup restore drill (extends `scripts/backup/restore-drill.ts`), and a deploy checklist in `web/docs/DEPLOY.md`.

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
