# load/ - local-only load harness

Load preparation for the multi-tenant scale goal. Everything here runs against a
throwaway local database and mocked providers. Nothing in this directory touches
production, real API keys, real tenant data, or the network.

## Files

- `runner-bench.ts` - in-process benchmark of the real scan-runner code path
  (`claimKeyedJob` -> `runJob` -> `verifyLeads` -> `finish`) with the LLM provider,
  page fetches and judge replaced by local mocks (`mock.ts`). Measures queue drain
  throughput, request-to-result turnaround, event-loop lag, and web-style read
  latency before and during the drain.
- `mock.ts` - synthetic provider/page fixtures on reserved `.example` names, plus a
  `fencedFetch` that fails any accidental real network call.
- `app-load.ts` - multi-tenant HTTP load against a local production build: seeds N synthetic
  tenants (users, sessions, a finished scan and leads, each carrying its own marker) in a
  throwaway SQLite file, starts 1..N `next start` processes under the test network fence (a
  local round-robin proxy in front when N > 1), and runs virtual users that each do one Home
  page view after another: `/app`, then the reads its components make (profile, jobs, usage,
  leads, scan status). Every response is checked for status, the tenant's own marker, and no
  other tenant's marker. Reports per-route latency (and time to first byte) and fails on the
  isolated-host thresholds: unexpected < 1%, correctness > 99.9%, zero tenant leaks, API p95
  < 1 s and p99 < 3 s, page p95 < 2 s.
- `http-smoke.ts` - dependency-free HTTP GET concurrency probe for a locally running
  instance. Refuses non-local hosts unless `LOAD_ALLOW_REMOTE=1` is set, and issues
  no writes (POST routes are deliberately absent).

## Run

```bash
cd web && npm install && cd ..
node --experimental-strip-types load/runner-bench.ts          # scan-runner benchmark
DB_PATH=/tmp/dazl-data/app.db npx --prefix web next dev -p 3100 &   # or next start after build
LOAD_BASE_URL=http://127.0.0.1:3100 node --experimental-strip-types load/http-smoke.ts
```

```bash
cd web && npm run build && cd ..
node --experimental-strip-types load/app-load.ts                      # 200 tenants, 100 VUs, 60 s, 1 process
LOAD_PROCESSES=2 LOAD_VUS=200 node --experimental-strip-types load/app-load.ts
```

Knobs (env): `LOAD_TENANTS LOAD_JOBS_PER_TENANT LOAD_READERS LOAD_PROVIDER_MS
LOAD_FETCH_MS LOAD_BASELINE_S LOAD_LEADS_PER_SCAN SCAN_MAX_CONCURRENT` for the bench;
`LOAD_VUS LOAD_DURATION_S LOAD_COOKIE LOAD_ALLOW_AUTH` for the smoke probe.

`http-smoke` against `next dev` includes compile time in latencies; use
`next build && next start` for steadier read-path numbers.

## What these numbers mean - and what they do not

The bench answers: does the app's own machinery (job claiming, verification, sync
SQLite reads/writes sharing one Node event loop, the in-process scheduler) hold
together when many tenants queue scans while browsers poll? It answers that on the
real code with synthetic work.

It does NOT measure capacity. The provider is a mock at fixed latency: real Anthropic
latency, 429s, token costs, TinyFish quotas and page-fetch variance are all outside
the fence. Any "N concurrent users/scans" claim additionally needs a real-provider
measurement inside an approved cost budget, which is a separate owner decision.

## Validation runs (sandbox, mocked provider - harness sanity evidence only)

| config | result |
| --- | --- |
| 20 tenants x 2 jobs, 8 readers, 800ms mock provider, SCAN_MAX_CONCURRENT=3 | 40/40 done, 200/200 leads verified, drain 12.8s (~188 jobs/min), event-loop p99 11.6ms busy, read p99 0.6ms idle and during drain |
| 200 tenants x 2 jobs, 32 readers, 400ms mock provider | 400/400 done, 2000/2000 leads, event-loop max 67.8ms, read p99 0.5ms during drain |

Interpretation: with an instant mock provider the runner/DB path is not the
bottleneck at these scales; turnaround is dominated by queue wait behind
`SCAN_MAX_CONCURRENT`. That supports the queued-scans design direction but says
nothing about thousands of simultaneous provider-bound scans.

## app-load results (sandbox: 4 vCPU shared with the load generator; local build, 500 tenants)

What it found: the single Node process is the ceiling (it sat at ~125% CPU, main thread pegged,
while the machine was 60% idle), and `/app` was the worst of it. Its first byte came fast, but
its body (the layout's per-request session check, streamed behind Suspense) waited on Next's
cacheComponents render phases, which need an idle event loop between them. APIs stayed fast;
pages queued. A CPU profile of the server under load: garbage collection 8%, better-sqlite3
`prepare` 6% (statements are prepared on every call), async_hooks/AsyncLocalStorage ~6%,
zlib compression ~1%, the rest Next's request and render runtime.

| build | processes | VUs | req/s | API p95 / p99 (ms) | page p95 (ms) | errors | leaks | result |
|---|---:|---:|---:|---|---:|---:|---:|---|
| main 0a30d14 | 1 | 100 | 109 | 41 / 2313 | 31916 | 1.9% (30 s timeouts) | 0 | fail |
| main + `connection()` only | 1 | 100 | 93 | 64 / 84 | 17684 | 0 | 0 | fail |
| main + `connection()` only | 2 | 100 | 182 | 67 / 99 | 12660 | 0.01% | 0 | fail |
| main + `connection()` only | 4 | 100 | 304 | 140 / 301 | 8348 | 0.01% | 0 | fail |
| static /app (separate PR) | 1 | 10 | 210 | 82 / 120 | 157 | 0 | 0 | pass |
| static /app | 1 | 100 | 218 | 648 / 796 | 1228 | 0 | 0 | pass |
| static /app | 2 | 100 | 482 | 389 / 531 | 733 | 0 | 0 | pass |
| static /app | 2 | 200 | 522 | 510 / 675 | 925 | 0.03% | 0 | pass |
| static /app | 4 | 200 | 628 | 494 / 868 | 1021 | 0.03% | 0 | pass |

(The first row used a keep-alive `http.Agent` client; its 30 s timeouts were partly that client
waiting on stalled bodies. Every later row uses `fetch`.)

Processes beyond one share one SQLite file here. That shows how far a second process moves
the ceiling; it is NOT a supported production topology: modules still on the raw SQLite handle,
and the per-process state listed in docs/PG_INVENTORY.md, make multiple instances a Postgres-
cutover step (#354). These are one machine's numbers, not a capacity claim; a rerun on the
isolated load-test host is the comparison that counts.
