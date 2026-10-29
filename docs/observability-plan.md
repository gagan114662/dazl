# Observability readiness plan

Status: design doc, 2026-10-22. Companion to `load/` (local load harness). Written
for the production-readiness goal: thousands of concurrent users with queued scans.
No instrumentation is merged yet - this is the plan the architecture slice should
consume, in the order below.

## Where we are today (grounded in the code)

- **Logging is `console.error` only.** Scan failures (`web/lib/scan/runner.ts`), tick
  stage failures (`web/app/api/internal/tick/route.ts`), ICP preview errors. No
  structured fields, no request logging, no per-tenant correlation.
- **No metrics anywhere.** The only introspection endpoint is `GET /api/health`,
  a `SELECT 1` against the auth DB (`web/app/api/health/route.ts`). It cannot see a
  stale build, a wedged runner, or a growing queue.
- **No served-build marker.** On 2026-10-22 an EADDRINUSE restart failure left the
  old build serving while health checks returned 200, and a merged fix appeared
  absent. A commit marker (served build ID verified against the merged SHA) is being
  added on the architecture branch; the metrics work below assumes it exists.
- **Scan execution lives in the web process.** `kickRunner` (runner.ts) is an
  in-process scheduler, `SCAN_MAX_CONCURRENT` default 3, jobs claimed from
  `scan_jobs` in SQLite. Kicks come from `POST /api/scan`, status polls, and the
  internal tick. `reapStaleJobs` runs on reads - there is no cron, so a quiet site
  never reaps.
- **The internal tick is one serial loop over tenants** (followups, sequences,
  watches, monitors, SEO indexing). One slow tenant delays every later tenant; there
  is no per-stage timing to even see it.
- **Rate limiting is per-process in-memory** (`web/lib/rate-limit.ts`). Correct at
  one instance, wrong the moment a second instance exists.
- **The DB is one synchronous better-sqlite3 connection (WAL).** Every request and
  every scan share the single Node event loop; a long sync query stalls all of them.

## The gaps that matter for the stated goal

1. **Queue depth and wait time are invisible.** For a queued-scans product the
   primary user-facing number is "how long until my scan starts/finishes", and
   nothing measures pending count, oldest pending age, or job duration.
2. **No event-loop or per-route latency.** The sync-SQLite failure mode at
   concurrency is exactly the one we cannot currently see.
3. **Provider boundary unmeasured.** Simultaneous-scan capacity is bounded by
   Anthropic key limits and TinyFish daily/per-minute quotas
   (`web/lib/search/tinyfish.ts` reads them from env). No counters exist for
   provider calls, 429s, retries, or spend, so the provider boundary cannot be
   reasoned about from data.
4. **Deploy truth.** Solved separately (commit marker, see above); listed because
   every "is the fix live" question routes through it.

## Phased plan

### P0 - this week, alongside the architecture slice (no new dependencies)

- `/api/internal/metrics`, gated like the tick route (`AUTOPILOT_TICK_SECRET`),
  hand-rolled counters/histograms, JSON (Prometheus text format optional later):
  - HTTP: request count and latency histogram by route + status class.
  - Scan queue: pending count, running count, oldest pending age, jobs
    finished/failed with duration histogram, drop-reason counts.
  - Tick: per-stage duration and per-tenant error count.
  - Process: event-loop lag (`perf_hooks.monitorEventLoopDelay`), RSS/heap.
- Structured JSON request logs (one line per request: route, status, ms, tenant
  hash). Cheap, greppable, feeds nothing yet.
- Adopt the commit-marker check in the deploy runbook: a deploy is "done" only when
  the served marker equals the merged SHA.

### P1 - lands on the async data-layer slice

- Query timing and (for Postgres) pool stats on the new async interface - the slice
  is the seam where this belongs; instrumenting the sync API first is wasted work.
- Per-tenant fairness metrics: queued/running jobs per tenant, per-tenant wait time.
- Runner split: scan execution out of the web process with a DB-backed lease, and
  rate limiting moved to the shared store. Both are prerequisites for a second
  instance; the metrics from P0 tell us when a second instance is actually needed.

### P2 - before any scale statement

- Alert rules: oldest pending age above threshold, event-loop p99 above threshold,
  provider 429 rate, tick stage failures, health-marker mismatch after deploy.
- SLO draft: web read p95, scan start p95 (queue wait), scan finish p95.
- Graduation criteria for quoting any concurrency number, in order:
  1. `load/runner-bench.ts` green at the target queue shape (harness level);
  2. a bounded real-provider canary (a handful of paid scans against staging) with
     provider metrics from P0/P1 recording latency, 429s and cost - requires an
     owner-approved spend budget, not yet granted;
  3. only then a stated range, with the measured provider boundary named.

## Explicit non-claims

- The `load/` harness numbers are harness validation on synthetic work, not
  capacity evidence. See `load/README.md`.
- This plan does not authorize provider spend, production load tests, or a second
  instance. Each needs its own go-ahead.
