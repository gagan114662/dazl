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
| attempts             | `MAX_ATTEMPTS` = 3, `attempts + 1` on claim (store.ts)          |
| non-retryable error  | `ProviderError` auth → `key_rejected`, no retry (runner.ts)     |
| error text cap       | `scan_jobs.error` CHECK ≤ 200 chars (store.ts)                  |
| status model         | pending → claimed → done/failed, claimed → pending (reap)       |

Additional guarantees the current code does **not** have:

- **Per-tenant fairness**: `claim` picks across tenants by oldest head-of-line
  item, with `perTenantInFlight` (default 1) capping how much one tenant can
  hold, so global FIFO starvation cannot occur *inside this adapter*.
  Production claiming is unchanged until the wiring PR lands.
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
