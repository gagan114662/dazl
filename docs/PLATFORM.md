# Platform inventory and Postgres migration plan

Snapshot of `web/` at df0bee5 (2026-10-27). Goal: run dazl.ai as a multi-tenant SaaS on Postgres with more than one app instance.

## Where we are

- Runtime store is one SQLite file (`DB_PATH`) opened by `getAuthDb()` (`web/lib/auth-db.ts`). Every module uses the synchronous better-sqlite3 API directly: about 600 `.prepare()` calls in 82 files under `web/lib` and `web/app`. There is no async data layer yet.
- Postgres today is a rehearsal path, not a runtime path:
  - `web/scripts/pg-migrate/extract-schema.ts` runs each module's `migrate*()` against a scratch SQLite DB and dumps the schema. `translate-schema.ts` turns that into `schema-full.generated.sql` (60 tables). `rehearse-full.ts` copies synthetic rows into a guarded `dazl_rehearse_*` database and checks them.
  - `web/lib/db/leads-read-pg.ts` is the only Postgres query code: the `LeadsReadDb` read slice, tested for equivalence with pg-mem. No route uses it.
- Tables are created at runtime by each module's `migrate*()` (`CREATE TABLE IF NOT EXISTS` plus `ALTER` in try/catch). There is no versioned migration runner.

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
| Scan runner loop and claiming | `lib/scan/runner.ts` `kickRunner`, `claimKeyedJob`, `reapStaleJobs` | Claiming is atomic only because SQLite has one writer | `FOR UPDATE SKIP LOCKED` claim and lease |
| Shutdown requeue | `instrumentation.ts` → `scan/shutdown-hook.ts` | Must requeue only this instance's jobs | Tag each claim with an instance id |
| Tick scheduler | `POST /api/internal/tick` (external cron) | Two overlapping ticks can send the same follow-up or sequence step twice | `pg_try_advisory_lock` per tick, plus per-tenant locks |
| Reopen send guard | `lib/outreach/reopen.ts` `inFlight` Set | Duplicate send across instances | Unique op key row or advisory lock |
| TinyFish minute window and breaker | `lib/search/tinyfish.ts` | Provider limit is exceeded N times | PG window row (daily usage is already in `tinyfish_usage`) |
| News request queue | `lib/search/news.ts` | Requests are spaced per instance only | Accept this, or use a PG advisory lock |
| Per-host crawl spacing | `lib/connectors/sitecrawl.ts` `lastHit` | Politeness spacing is per instance | Accept this (best effort) |
| Source result caches | `lib/sources/{youtube,jina,github,v2ex}.ts` | Cache is per instance | Fine to keep |
| Migration-ran flags | `lib/scan/service.ts` `ready`, and similar | None, once migrations run on deploy | Remove after step 2 |

## Migration plan (one PR per step, at most 2 open at a time)

1. **This doc.**
2. **Postgres as the real store.**
   - Add an async `Db` interface (`query`/`get`/`all`/`run`/`tx`) with SQLite and PG adapters. Select the adapter with `DATABASE_URL`; SQLite stays the default.
   - Move modules to it one area at a time, without changing behaviour. This is the bulk of the work: around 600 call sites change from sync to async.
   - Add the 12 SQLite-only tables to `extract-schema.ts` first, so the PG DDL covers every table.
   - Replace the ad-hoc `migrate*()` functions with numbered SQL migrations that run on deploy. PG uses an advisory lock so only one instance migrates.
   - CI: run the test suite twice, once on SQLite and once on a `postgres:16` service container.
   - Watch for SQL dialect differences: `?` vs `$n` parameters, `strftime`/`unixepoch`, `INSERT OR IGNORE`/`ON CONFLICT`, int8 values coming back as strings (see `leads-read-pg.ts` `num()`), and FTS (none found yet).
   - Given the size, this step will probably need several PRs (adapter and CI first, then areas).
3. **Shared state.** Move the in-memory table above to PG as listed. Add a test that runs two runner processes against one PG database and asserts that each job and each send is processed exactly once.
4. **Tenant isolation.** Build a route table from `app/api/**/route.ts`. For each route, seed tenants A and B, then assert that A gets a 404 or 403 on B's ids and that B's rows are unchanged.
5. **Stripe e2e (test mode).** Use signed fixture events with `STRIPE_WEBHOOK_SECRET`, covering checkout → upgrade → portal → cancel → downgrade. Flag to the owner: Free = 50 BYOK scans a month, but the site says "3 trial scans then BYOK", and Pro ($49) says "unlimited".
6. **Ops.** `/api/health` checks the DB and the worker heartbeat. Add a structured error log with an alert hook, a scheduled backup restore drill (extends `scripts/backup/restore-drill.ts`), and a deploy checklist in `web/docs/DEPLOY.md`.

## Out of scope here
`worker/` and `session-worker/` (Hermes side, separate stores) and the external Hermes tunnel writes. The write fence (`lib/write-fence.ts`) does not cover these, so the cutover runbook must pause them separately.
