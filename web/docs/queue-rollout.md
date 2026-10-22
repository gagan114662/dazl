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
   Effective global budget: the legacy loop and the queue bridge share one
   in-process slot counter (lib/scan/run-slots.ts), so mixed mode cannot
   exceed SCAN_MAX_CONCURRENT in total; without that shared count the two
   runners would each run up to the cap and double provider/host exposure.
   The bound is in-process only - one Node process serves :3100 today; any
   future multi-worker setup needs a durable global bound before activation
   there.
3. Restart/rollback plan: activation = env edit + process restart (the only
   writer process). Rollback = remove tenant id + restart. Queue rows are
   inert in legacy mode; legacy-mode recovery of queue-claimed rows is via
   reapStaleJobs (bounded 20min) - acceptable, documented.
4. In-flight reconcile at cutover: before enabling for a tenant, verify zero
   running jobs for that tenant (or wait for drain); the bridge's fresh-row
   bind refusal protects a live claim, but cutover at idle removes the case.
5. Canary scope is ONE tenant (the test tenant), enforced twice in code:
   (a) the bridge claims with perTenantInFlight: 1 pinned EXPLICITLY (not
   inherited from the adapter default, which a future adapter edit could
   change) - the queue tenant holds at most one of the shared slots, so a
   continuous queue-tenant backlog cannot starve legacy tenants;
   (b) queueTenants() fails closed to pure legacy when DAZL_QUEUE_TENANTS
   lists more than one id. A broader tenant list is a separate reviewed
   change with its own slot-policy decision, never an ops edit.
6. Slot tails and recovery honesty: post-finish network work (contact crawl,
   enrichment) holds a run slot for seconds to minutes after the scan itself
   completes (bounded by per-request timeouts, worst case roughly 8 sites x
   (robots + 5 pages) x (10s timeout + 2s gap)). A slot is released only when
   its run promise settles; there is deliberately NO watchdog release -
   freeing a slot while the old work continues uncancelled can double-run
   provider calls. If slots ever wedge, the recovery is a process restart
   (reapStaleJobs re-claims the abandoned rows within the bounded window),
   not a force-release. A cancel/ownership/heartbeat design for safe timeout
   release is a separate architecture assessment owed before any broader
   rollout.
7. Guard metrics (logged, no new infra): per-kick counts - mirrored, claimed,
   bind_refused, reaped, stale_token_rejections; scan_jobs status distribution
   for the tenant before/after. Rollback triggers: any bind_refused spike,
   any double-run evidence (two running rows sharing identity, duplicate
   provider spend), attempts advancing without domain progress.
8. Live validation, two stages:
   Stage 1 (no provider, no spend, prerequisite): a bounded synthetic dry-run
   for the exact test tenant `53d74a4bebd48368144a5e23f509a97e`
   (OUTREACH_TEST_TENANT_ID in the run env). A stub-executor path wired ONLY
   for this tenant id exercises claim -> domain bind -> finish -> queue
   completion and the restart/reap paths against the real DB with zero
   provider or outreach calls. Requires a small code path (proposal only).
   No fake customer data; the dry-run job is removed after.
   Stage 2 (real end-to-end, SPEND - do not request yet): one tiny scan on the
   same test tenant with its own key. This is blocked until provider cost is
   grounded: per-scan cost, actual TinyFish billing rate, any cost cap, and
   the maximum spend this validation could reach are currently UNKNOWN (the
   TinyFish free allowance does not prevent wallet spend and no quota endpoint
   exists - open item from the #147 review, still active). Ask for this scan
   only after those numbers are grounded or the user makes an explicit budget
   choice. Autopilot stays unconfigured for the test tenant throughout.

## Backup/schedule status (read-only, grounded on host 2026-10-22)

- ~/backups EXISTS (metadata verified read-only, no bytes read): six sqlite
  snapshots, all 2026-10-19 - two pre-cutover (~24MB, 0600 ubuntu:ubuntu,
  'SQLite format 3' headers verified) and four pre-dq24x (latest 05:57) -
  plus two dazl-data tgz (~190-200MB) and Caddyfile copies. The snapshots are
  ~24MB while the live DB (~/dazl-data/dazl-pr16.db) is ~1.2MB, so the
  snapshots appear to be from an earlier data era - same-era coverage of the
  CURRENT DB is unknown.
- NO scheduled backup: the only cron is the */5 tick. /etc/cron.d has nothing.
- Implication: the newest observed snapshot is from Oct 19. That is a snapshot
  AGE observation, not a validated RPO: no restore drill has run, snapshot
  consistency is unproven, and DAZL_MASTER_KEY being present in the env is not
  proof the historical snapshots' secrets decrypt with it. A real restore
  drill touches private data and needs its own privacy/scope decision plus a
  safe consistent-copy method - not assumed here. The merged backup tooling
  (scripts/backup) is ready; SCHEDULE, off-box copy and retention remain open
  owner decisions.

## Explicitly out of scope for activation prep

- Other queue kinds (followup/sequence/watch/monitor/index-check) - no
  defined domain fence per kind yet; scans only.
- Any change to the */5 cron, other tenants, or provider config.
- PG migration cutover (separate track; the queue works on SQLite by design).
