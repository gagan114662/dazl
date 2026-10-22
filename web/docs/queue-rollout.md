# Queue mode controlled rollout proposal (DAZL_QUEUE_SCANS)

Status: PROPOSAL. Queue code is merged default-OFF (main, deployed inert).
Production activation is NOT approved by this document; it is the checklist a
separate explicit activation decision must satisfy.

## What exists today (grounded 2026-10-22)

- Adapter + bridge merged: SqliteQueue (durable, fenced tokens, backoff) and
  kickQueueRunner behind a single gate in kickRunner. Independent review
  cleared both, incl. a real 2-OS-process probe (160 kicks, 12 jobs, zero
  duplicate runs - a bounded proof, not a universal exactly-once guarantee).
- Runtime: legacy path confirmed live (flag absent from run env).
- Writers/kickers of scan execution (code inventory):
  - app/api/internal/tick/route.ts - the */5 host cron POSTs here (only cron
    on the box, crontab-verified); kicks runner on watch/monitor activity.
  - app/api/scan/route.ts + app/api/scan/csv/** - kick after enqueue.
  - app/api/scan/status/route.ts - kicks when a polled job is pending.
  - Job INSERTs: lib/scan/store.ts, lib/scan/csv-import.ts,
    lib/scan/commenter-import.ts.
  - "Hermes" is a comment-only concept today (claimKeyedJob leaves keyless
    non-trial jobs "for a worker such as Hermes"); no Hermes code runs.
  - One Node process serves :3100; all kicking is in-process.

## Activation preconditions (all must hold)

1. Tenant-scoped flag, not a global one. Add DAZL_QUEUE_TENANTS=<ids> so queue
   mode applies ONLY to listed tenants (the OUTREACH_TEST_TENANT_ID pattern
   already exists in the run env). A tenant not in the list stays bit-for-bit
   on the legacy path: no provider use, no queue behavior change. This needs a
   small gate change (kickRunner routes per-job, not globally) - implement
   under review before any activation. Global DAZL_QUEUE_SCANS=on should never
   be used in prod.
2. Config coherence: queue lease derives from SCAN_STALE_RUNNING_S (already
   single-sourced in the bridge). Activation config review must confirm no
   second process sets a divergent value and SCAN_MAX_CONCURRENT is unchanged.
3. Restart/rollback plan: activation = env edit + process restart (the only
   writer process). Rollback = remove tenant id + restart. Queue rows are
   inert in legacy mode; legacy-mode recovery of queue-claimed rows is via
   reapStaleJobs (bounded 20min) - acceptable, documented.
4. In-flight reconcile at cutover: before enabling for a tenant, verify zero
   running jobs for that tenant (or wait for drain); the bridge's fresh-row
   bind refusal protects a live claim, but cutover at idle removes the case.
5. Guard metrics (logged, no new infra): per-kick counts - mirrored, claimed,
   bind_refused, reaped, stale_token_rejections; scan_jobs status distribution
   for the tenant before/after. Rollback triggers: any bind_refused spike,
   any double-run evidence (two running rows sharing identity, duplicate
   provider spend), attempts advancing without domain progress.
6. Live validation WITHOUT provider/outreach: enable for the test tenant and
   run a synthetic job whose provider is unreachable-by-design? NO - that
   burns attempts against real config. Instead: dry-run path - a scan job for
   the test tenant is claimed, bound, and completed by a stub executor only if
   one is explicitly wired for the test tenant (requires a small code path;
   proposal only). No fake customer data: use the existing test tenant's own
   fixture job pattern (?job_id= deep link + poll + remove), which exercises
   real claim/bind/finish with the tenant's own key and a trivially small
   query, then remove the job. Provider spend for one tiny test-tenant scan is
   the minimum honest end-to-end proof; it requires the explicit activation
   decision to say so. No outreach/autopilot for the test tenant (it is not
   configured for autopilot today - keep it that way during validation).

## Backup/schedule status (read-only, grounded on host 2026-10-22)

- ~/backups EXISTS: two manual pre-cutover snapshots (dazl-pre-cutover-
  20261019-*.sqlite), dazl-data tgz archives, Caddyfile copies. Manual,
  one-off, latest 2026-10-19.
- NO scheduled backup: the only cron is the */5 tick. /etc/cron.d has nothing.
- Implication: RPO today = last manual snapshot (3 days and drifting). The
  merged backup tooling (scripts/backup) is ready; the SCHEDULE, off-box copy
  and retention policy remain open owner decisions - not assumed here.

## Explicitly out of scope for activation prep

- Other queue kinds (followup/sequence/watch/monitor/index-check) - no
  defined domain fence per kind yet; scans only.
- Any change to the */5 cron, other tenants, or provider config.
- PG migration cutover (separate track; the queue works on SQLite by design).
