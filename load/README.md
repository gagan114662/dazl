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
