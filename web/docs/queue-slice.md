# Queue slice: claiming/execution decoupling

Status: preparation slice. `web/lib/queue/**` is new and self-contained; nothing
in the existing runner, store, or tick route is changed by this PR. Wiring is a
later, separately reviewed step.

## Why

All background work is executed inline in the one Node process today:

- Scan jobs are claimed by `claimKeyedJob` and run by `kickRunner`
  (`web/lib/scan/runner.ts`). Claiming is a single global FIFO
  (`ORDER BY created_at, rowid LIMIT 1`) across all tenants.
- Follow-ups, sequences, watches, monitors and SEO index checks run as
  sequential per-tenant loops inside `POST /api/internal/tick`
  (`web/app/api/internal/tick/route.ts`), called by the scheduler cron.

Consequences, all observable in the current code:

1. **Head-of-line blocking across tenants.** One tenant's backlog (e.g. a
   50-domain CSV batch) sits ahead of every other tenant's manual scan in the
   global FIFO. `countActiveJobs` already exempts CSV jobs from the per-user
   quota, so batches can be large.
2. **No retry spacing.** `failOrRetry` re-pends a failed attempt immediately,
   so a provider outage burns all `MAX_ATTEMPTS` (3) within seconds.
3. **No per-tenant concurrency bound.** `kickRunner` caps only global
   concurrency (`SCAN_MAX_CONCURRENT`, default 3); one tenant can hold all
   slots. Parallel runs of one tenant also buy little: its scans share one
   LLM key and the per-tenant TinyFish caps.
4. **Tick is a monolith.** A slow tenant's followup sync delays the watches,
   monitors and index checks queued behind it in the same request.

## What this slice adds

`web/lib/queue/` defines the seam:

- `types.ts` — the `QueueAdapter` contract (`enqueue` / `claim` / `complete` /
  `fail` / `reapExpired` / `get` / `depth`) with the invariants below.
- `backoff.ts` — exponential backoff with cap and jitter for `fail` retries.
- `memory.ts` — `InProcessQueue`, the reference implementation, dependency-free
  so `node --test` runs it without the app stack.
- `index.ts` — barrel export.

`web/test/queue.test.ts` pins the semantics (14 tests, all synthetic, no
network, no database).

## Invariants (any backend must keep these)

These mirror semantics the current code already relies on, so swapping storage
does not change callers:

| Queue concept        | Current code anchor                                             |
| -------------------- | --------------------------------------------------------------- |
| claim fencing token  | `finish()` writes only if `attempts` still matches (runner.ts)  |
| lease + reap         | `reapStaleJobs`, `STALE_RUNNING_S` = 20 min (store.ts)          |
|                      | (queue diverges deliberately: reaped attempts re-pend WITH      |
|                      | backoff, so a crash-looping job cannot spin through attempts)   |
| attempts             | `MAX_ATTEMPTS` = 3, `attempts + 1` on claim (store.ts)          |
| non-retryable error  | `ProviderError` auth → `key_rejected`, no retry (runner.ts)     |
| error text cap       | `scan_jobs.error` CHECK ≤ 200 chars (store.ts)                  |
| status model         | pending → claimed → done/failed, claimed → pending (reap)       |

Additional guarantees the current code does **not** have:

- **Per-tenant fairness, bounded not proven**: `claim` picks across tenants
  by oldest head-of-line item, with `perTenantInFlight` (default 1) capping
  how many slots one tenant can hold. This strictly improves on the global
  FIFO (other tenants claim in parallel up to `maxInFlight` instead of
  waiting behind one backlog), but it is NOT unconditional starvation
  freedom: a tenant with an old finite backlog keeps winning the
  head-of-line comparison until that backlog drains, and no weighted
  fairness is proven. Production claiming is unchanged until wiring.
- **Backoff**: `fail(retryable)` sets `notBefore = now + backoff(attempt)`
  (30s base, 2x, 30min cap, ±20% jitter) instead of immediate re-pend.
- **Idempotent enqueue**: optional `dedupeKey`, namespaced per tenant+kind,
  makes re-enqueue of active work a no-op (e.g. the weekly monitor tick cannot
  double-enqueue a run). Terminal items release the key so recurring work can
  schedule its next run.

## Integration seam (later PRs, not this one)

Wiring the in-process adapter does not depend on the data-layer migration:
steps 1-3 below can land on SQLite today. Only the durable SQL backend
(further below) needs Postgres.

1. **Scan runner**: `kickRunner` claims through the adapter with
   `kinds: ['scan']`, `maxInFlight: SCAN_MAX_CONCURRENT`, and maps the claim
   token to the `scan_jobs.attempts` fencing it already does. Scan job rows
   stay the source of truth for results; the queue row carries scheduling
   state only (`id` can be the existing `scan_jobs.id`).
2. **Tick route**: each inline loop becomes enqueue-into-queue; the tick
   request itself returns after enqueueing, and workers drain by kind. The
   per-workload shapes (followups need `tenant_id` only, monitors carry
   `monitor:<id>:<dueDay>` dedupe keys) are visible in the tick route today.
3. **External worker (Hermes)**: claims `kinds: ['scan']` with its own lease;
   the HTTPS claim/complete API maps 1:1 onto `claim`/`complete`/`fail`.

## Known limits of the in-process adapter

- `claim()` is O(N) over stored items; fine at expected scale, the SQL
  backend replaces the scan with an index.
- FIFO within a tenant: a tenant's manual scan queues behind its own
  earlier CSV batch. Per-kind lanes are future work.
- Caller-supplied ids must be unique per run, including terminal items: a
  completed item keeps its id, so recurring workloads mint a fresh id each
  run (`scan_jobs` already does).
- The claim token fences only the queue row. A worker mutating domain
  tables (leads, sequences, followups) must keep its own domain-level
  ownership check, the way scan writes guard on `scan_jobs.attempts`;
  adding those guards is part of each wiring PR.
- State is in-memory: items do not survive a process restart. That is
  acceptable only for workloads whose source of truth is a domain table
  (scan jobs re-pend via their own row); the durable backend is the fix.

## Postgres backend (after the data-layer migration lands)

The SQL backend is a documented later step, not part of this slice:

- Claim: `UPDATE ... SET status='claimed', claim_token = nextval(...),
  lease_expires_at = now() + lease WHERE id = (SELECT id FROM queue_items
  WHERE status='pending' AND not_before <= now() AND kind = ANY(?)
  AND tenant eligible under caps ORDER BY created_at LIMIT 1
  FOR UPDATE SKIP LOCKED) RETURNING *` — `SKIP LOCKED` replaces the
  in-process mutex this adapter gets for free.
- Per-tenant in-flight caps are enforced in the same statement with a
  subquery count of claimed rows per tenant.
- The fencing token becomes a sequence (or the existing attempts counter);
  `complete`/`fail` keep the `WHERE claim_token = ?` guard.

## Boundaries

- Owns: `web/lib/queue/**`, `web/docs/queue-slice.md`, `web/test/queue.test.ts`.
- Does not touch: runner, store, tick route, cron, health endpoint, anything
  under `web/scripts/pg-migrate/**` or the write fence (owned by the
  data-layer slice), security patch files, load harness.
- No production access, no cron changes, no live DB writes; tests are
  synthetic and in-memory only.

## Fair service (#355, shared adapter `DbQueue` only)

- **Lanes** (`LANES` in `lib/queue/types.ts`): a claim with `lane: true` counts `maxInFlight` and
  `perTenantInFlight` over its own `kinds` only, so research holding every research slot never blocks a reply
  check or suppression. `replies` (reply-check, suppression, followup, sequence; 4 slots) and `research` (scan,
  enrich, monitor, watch, index-check; 3 slots).
- **Round-robin** (`order: 'round_robin'`): the tenant whose last claim is oldest goes first (never claimed counts
  as oldest), then its oldest item. `work_queue_meta` row `t:<tenant>` holds the token of the tenant's last claim;
  claims are already serialized by the token row, so the order holds across instances. The shared scan claimer
  uses it. The default stays FIFO, so the in-process and SQLite adapters keep parity (they refuse the new options).
- **Admission** (`maxBacklog` on enqueue): refuses a tenant's item when it already has that many active items of
  the kind; returned as `{created: false, refused: 'backlog'}`, nothing written. Serialized per tenant and kind by
  the `a:<tenant>:<kind>` meta row (Postgres row lock), so racing instances admit exactly the limit.
- **Dead letters**: `failed()` lists them; `replay(id)` puts one back (attempts reset). A token from the dead
  attempt stays stale.
- **Alerts** (`lib/queue/alerts.ts` over `DbQueue.stats()`): a kind whose oldest due item waited past its limit
  (15 min reply checks, 5 min suppression, 30 min follow-ups and sequences, 60 min otherwise), more than 20 dead
  letters, or an expired claim nobody reaped. `/api/ready` reports them as `queue.alerts` (kinds and counts only)
  without becoming unready; the error reporter gets one record when the set changes. The statistics are read outside
  the mandatory queue check (the reachability `SELECT`), under their own budget (500 ms by default): when the read
  throws, hangs or runs over it the body says `queue: {alerts: null, reason: 'error' | 'timeout'}` and the instance
  stays ready. Only the queue's reachability failing or timing out fails readiness.
- Proof: `test/queue-fair.test.ts` on both engines, including a load simulation (one tenant with 300 slow scans,
  four tenants with reply checks every minute and a scan every fifth): with lanes and round-robin every reply check
  is served in its minute and every quiet scan within four rounds; with one shared pool, 32 of 160 reply checks
  are reached at all.
- Not yet: the tick route's follow-ups, sequences, watches and monitors still run inline (serially per tenant);
  moving them onto lane workers is the next slice, as is the load test on the dedicated load-test host.
