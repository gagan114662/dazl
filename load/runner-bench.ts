// In-process load benchmark for the scan runner and its shared SQLite database.
//
// What it measures, on the REAL code path (claim -> runJob -> verify -> finish):
//   - queue drain throughput for synthetic trial-funded scan jobs
//   - per-job duration distribution
//   - event-loop lag while sync better-sqlite3 reads/writes share one Node process
//   - web-style read latency (status polls + lead lists) before and during the drain
//
// What it CANNOT claim: real capacity. The LLM and page fetches are local mocks with
// fixed latency; provider rate limits, token costs and real page-fetch variance are
// outside this harness. See load/README.md before quoting any number from it.
//
// Runs fully offline: DAZL_TRIAL_ANTHROPIC_KEY is a dummy string the mock ignores,
// SITECRAWL is disabled, and fetchImpl is fenced. Run from the repo root:
//   node --experimental-strip-types load/runner-bench.ts
//
// Knobs (env): LOAD_TENANTS=20 LOAD_JOBS_PER_TENANT=2 LOAD_READERS=8
//   LOAD_PROVIDER_MS=800 LOAD_FETCH_MS=40 LOAD_BASELINE_S=8 LOAD_LEADS_PER_SCAN=5
//   SCAN_MAX_CONCURRENT=3 LOAD_DB=<path> (default: mktemp file)

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

process.env.SITECRAWL_ENABLED = '0'
delete process.env.TINYFISH_API_KEY // TinyFish path stays disabled even if the shell exports a key
// Each synthetic tenant gets its own stored (encrypted) key, the BYOK path: the trial path now needs TinyFish and
// trial caps, which this offline bench never enables. The mock provider ignores the key; it never leaves the process.
const MASTER = randomBytes(32)
process.env.DAZL_MASTER_KEY = MASTER.toString('base64')
process.env.SCAN_MAX_CONCURRENT = process.env.SCAN_MAX_CONCURRENT ?? '3'

const TENANTS = num('LOAD_TENANTS', 20)
const JOBS_PER_TENANT = num('LOAD_JOBS_PER_TENANT', 2)
const READERS = num('LOAD_READERS', 8)
const PROVIDER_MS = num('LOAD_PROVIDER_MS', 800)
const FETCH_MS = num('LOAD_FETCH_MS', 40)
const BASELINE_S = num('LOAD_BASELINE_S', 8)
const LEADS_PER_SCAN = num('LOAD_LEADS_PER_SCAN', 5)
const TOTAL_JOBS = TENANTS * JOBS_PER_TENANT

function num(name: string, dflt: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
function stats(values: number[]): { n: number; p50: number; p95: number; p99: number; max: number; mean: number } {
  const s = [...values].sort((a, b) => a - b)
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0
  return { n: s.length, p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), p99: +pct(s, 99).toFixed(1), max: +(s[s.length - 1] ?? 0).toFixed(1), mean: +mean.toFixed(1) }
}

async function main() {
  // Imports happen after env setup: SCAN_MAX_CONCURRENT is read at module load.
  // Resolve the native driver against web/node_modules (this file lives outside web/).
  const require = createRequire(new URL('../web/package.json', import.meta.url))
  const Database = require('better-sqlite3') as typeof import('better-sqlite3').default
  const { migrateScan, createQueryJob, getJob } = await import('../web/lib/scan/store.ts')
  const { migrateTrial } = await import('../web/lib/scan/trial.ts')
  const { migrateMemory } = await import('../web/lib/memory.ts')
  const { migrateWatch } = await import('../web/lib/watch.ts')
  const { migrateMonitors } = await import('../web/lib/monitors.ts')
  const { migrateConnectors } = await import('../web/lib/connectors/store.ts')
  const { migrateAutopilot } = await import('../web/lib/outreach/autopilot.ts')
  const { migrateLedger } = await import('../web/lib/outreach/ledger.ts')
  const { migrateSourceRuns } = await import('../web/lib/scan/source-runs.ts')
  const { migrateKeys, saveKey } = await import('../web/lib/llm/key-store.ts')
  const { kickRunner } = await import('../web/lib/scan/runner.ts')
  const { syntheticBatch, mockProvider, mockFetchPage, fencedFetch } = await import('./mock.ts')

  const dir = mkdtempSync(join(tmpdir(), 'dazl-load-'))
  const dbPath = process.env.LOAD_DB ?? join(dir, 'bench.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // Mirrors the production schema path: the same migrate functions getScanDb chains,
  // minus the ones behind next/headers. Plus the users table auth-db.ts creates.
  db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()))`)
  for (const m of [migrateScan, migrateTrial, migrateMemory, migrateWatch, migrateMonitors, migrateConnectors, migrateAutopilot, migrateLedger, migrateSourceRuns, migrateKeys]) m(db)

  const now = new Date()
  const tenants: string[] = []
  for (let t = 0; t < TENANTS; t++) {
    const id = `load-tenant-${t}`
    db.prepare('INSERT INTO users (id, email, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?)').run(id, `${id}@loadtest.example`, `Loadtest ${t}`, 'x', 'x')
    saveKey(db, id, 'anthropic', `sk-ant-api03-LOADHARNESS${String(t).padStart(6, '0')}MOCKONLY`, MASTER)
    tenants.push(id)
  }

  // Synthetic jobs on each tenant's own (mock) key.
  const batches: ReturnType<typeof syntheticBatch>[] = []
  const pageIndex = new Map<string, ReturnType<typeof syntheticBatch>[number]>()
  const jobIds: string[] = []
  const icp = JSON.stringify({ summary: 'load test icp', include: [], exclude: [], where: [] })
  for (let j = 0; j < TOTAL_JOBS; j++) {
    const tenant = tenants[j % tenants.length]
    const id = createQueryJob(db, tenant, { query: `load test query ${j}`, icp })
    const batch = syntheticBatch(id, now, LEADS_PER_SCAN)
    batches.push(batch)
    for (const b of batch) pageIndex.set(b.lead.source_url, b)
    jobIds.push(id)
  }

  // Hard fence, belt and braces: any code path that falls back to the global fetch
  // (default parameters, the connector worker, anything not taking deps.fetchImpl)
  // gets an instant 503 instead of egress. Mocks do not use the global fetch.
  globalThis.fetch = fencedFetch()
  const provider = mockProvider(batches, { providerMs: PROVIDER_MS, fetchMs: FETCH_MS })
  const fetchPage = mockFetchPage(pageIndex, { providerMs: PROVIDER_MS, fetchMs: FETCH_MS })
  const deps = {
    providers: { anthropic: provider },
    fetchPage,
    judge: async () => 'supports' as const,
    fetchImpl: fencedFetch(),
    ground: false,
    score: false,
    memory: null,
    master: MASTER,
  }

  // Web-style readers: status poll + lead-list read per iteration, like an open dashboard.
  const readsIdle: number[] = []
  const readsBusy: number[] = []
  let busy = false
  let stopReaders = false
  const queueDepthSamples: number[] = []
  const readOnce = (tenant: string, jobId: string) => {
    const t0 = performance.now()
    getJob(db, tenant, jobId)
    // Same join the leads API uses (leads has no user_id column).
    db.prepare('SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? ORDER BY l.created_at DESC LIMIT 50').all(tenant)
    const ms = performance.now() - t0
    ;(busy ? readsBusy : readsIdle).push(ms)
  }
  const readers = Array.from({ length: READERS }, (_, r) => (async () => {
    while (!stopReaders) {
      readOnce(tenants[r % tenants.length], jobIds[r % jobIds.length])
      await new Promise(res => setTimeout(res, 250)) // ~4 polls/s per reader
    }
  })())

  const lag = monitorEventLoopDelay()
  const sampler = setInterval(() => {
    lag.reset() // percentiles snapshot per phase via manual read below
    const q = db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE status = 'pending'").get() as { n: number }
    queueDepthSamples.push(q.n)
  }, 500)

  // Phase 1: baseline read load, no scans queued yet (jobs are pending but runner not kicked;
  // reaper only touches stale running jobs, so pending rows sit).
  const lagIdle = monitorEventLoopDelay(); lagIdle.enable()
  await new Promise(res => setTimeout(res, BASELINE_S * 1000))
  lagIdle.disable()

  // Phase 2: drain. Polling kick loop models the cron tick + status-poll kicks in prod.
  busy = true
  const lagBusy = monitorEventLoopDelay(); lagBusy.enable()
  const drainStart = performance.now()
  const kicker = setInterval(() => { void kickRunner(db, deps) }, 300)
  void kickRunner(db, deps)
  const isSettled = () => (db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE status IN ('pending','running')").get() as { n: number }).n === 0
  while (!isSettled()) await new Promise(res => setTimeout(res, 250))
  clearInterval(kicker)
  const drainMs = performance.now() - drainStart
  lagBusy.disable()

  stopReaders = true
  clearInterval(sampler)
  await Promise.all(readers)

  // Correctness + per-job durations from the DB, not from the harness's own bookkeeping.
  // finish() clears claimed_at, so measure request-to-result turnaround from created_at.
  const rows = db.prepare("SELECT j.status, j.created_at, j.finished_at, j.error, (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS lead_count FROM scan_jobs j").all() as { status: string; created_at: number; finished_at: number | null; lead_count: number; error: string | null }[]
  const durations = rows.filter(r => r.finished_at).map(r => (r.finished_at! - r.created_at) * 1000)
  const done = rows.filter(r => r.status === 'done')
  const failed = rows.filter(r => r.status === 'failed')
  const leadRows = (db.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n

  const report = {
    config: { tenants: TENANTS, jobs_per_tenant: JOBS_PER_TENANT, total_jobs: TOTAL_JOBS, readers: READERS, provider_ms: PROVIDER_MS, fetch_ms: FETCH_MS, scan_max_concurrent: Number(process.env.SCAN_MAX_CONCURRENT), leads_per_scan: LEADS_PER_SCAN },
    drain: {
      wall_s: +(drainMs / 1000).toFixed(1),
      jobs_per_min: +((TOTAL_JOBS / drainMs) * 60000).toFixed(1),
      turnaround_ms: stats(durations),
      max_queue_depth: Math.max(...queueDepthSamples, 0),
    },
    event_loop_lag_ms: {
      idle_p50: +(lagIdle.percentile(50) / 1e6).toFixed(1), idle_p99: +(lagIdle.percentile(99) / 1e6).toFixed(1), idle_max: +(lagIdle.max / 1e6).toFixed(1),
      busy_p50: +(lagBusy.percentile(50) / 1e6).toFixed(1), busy_p99: +(lagBusy.percentile(99) / 1e6).toFixed(1), busy_max: +(lagBusy.max / 1e6).toFixed(1),
    },
    web_read_ms: { idle: stats(readsIdle), during_drain: stats(readsBusy) },
    correctness: {
      jobs_done: done.length, jobs_failed: failed.length,
      fail_reasons: failed.map(f => f.error),
      leads_written: leadRows,
      expected_leads: done.length * LEADS_PER_SCAN,
      done_with_zero_leads: done.filter(d => !(d.lead_count && d.lead_count > 0)).length,
    },
    caveat: 'Mocked provider at fixed latency. This measures the app/DB/runner path only, never provider or network capacity. Not a capacity claim.',
  }
  console.log(JSON.stringify(report, null, 2))
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

main().catch(e => { console.error('LOAD BENCH FAILED:', e); process.exit(1) })
