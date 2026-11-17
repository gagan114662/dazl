// The scan worker's loop (#836): a second process that takes scans from the shared work queue, beside the app.
// scripts/scan-worker.mts runs it; ops/staging/dazl-staging-worker.service starts that script on staging.
//
// It only kicks the scan runner (kickRunner, lib/scan/runner.ts), the same call every app kick makes, and only while
// DAZL_SCAN_SHARED_QUEUE is exactly 1: with the flag on, kickRunner claims through the work queue, where one scan has
// one claim at a time across every process. With the flag off the worker stays idle and never calls kickRunner, so a
// second process never runs the in-process claimers. It runs no tick work (replies, follow-ups, watches, monitors) and
// listens on no port.
//
// A pass with no pending or running scan and no open scan queue item is indexed reads and no write. While any scan is
// running (here or in the app) a pass is a kick, and a kick is one small write transaction (the claim takes a fencing
// token before it knows whether anything is claimable), so every 5 s for as long as a scan runs. A running scan
// counts as work because the kick also frees scans whose worker died (the lease).
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { sharedScanQueue } from '../queue/scan-claimer.ts'
import { captureError } from '../ops/errors.ts'
import { instanceId } from '../ops/instance.ts'
import { recordProcessErrors } from '../ops/process-errors.ts'
import { getAuthDb } from '../db/sqlite-store.ts'
import { kickRunner, type RunDeps } from './runner.ts'
import { installShutdownRequeue } from './shutdown-hook.ts'

export const WORKER_INTERVAL_DEFAULT_MS = 5000
// How often the worker looks for work: SCAN_WORKER_INTERVAL_MS, 250 ms to 60 s. Unset, blank or anything else is 5 s.
export function workerIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SCAN_WORKER_INTERVAL_MS?.trim()
  if (!raw || !/^\d{1,6}$/.test(raw)) return WORKER_INTERVAL_DEFAULT_MS
  const n = Number(raw)
  return n >= 250 && n <= 60_000 ? n : WORKER_INTERVAL_DEFAULT_MS
}
// How many scans the worker runs at once: SCAN_WORKER_CONCURRENCY, 1 to 8, default 1 (the worker shares a small box
// with the app; one scan at a time bounds its memory). It becomes this process's SCAN_MAX_CONCURRENT (run-slots.ts).
export function workerConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SCAN_WORKER_CONCURRENCY?.trim()
  return raw && /^[1-8]$/.test(raw) ? Number(raw) : 1
}

export interface ScanWorkerOpts {
  db: Database.Database
  kick: (db: Database.Database, deps?: RunDeps) => Promise<void>
  deps?: RunDeps
  intervalMs?: number
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}

// The store is set up when the tables a kick reads exist. The worker runs no scan-table migrations of its own: the
// deploy's migrate-and-seed step (ops/staging/deploy.sh) and the app create them, and a second process running that
// whole setup at the same moment is how two processes used to collide. What it does run is what any kick runs, all
// idempotent: the auth tables on open (getAuthDb), the queue tables (CREATE IF NOT EXISTS) and the runner's own lazy
// table checks. Until the scan tables exist a pass does nothing and the next one looks again.
// Table checks are plain SELECTs that fail on a missing table, not catalog reads, so every statement here is one both
// engines accept (test/pg-sql-audit.test.ts). Only "no such table" means not there; any other error is real.
function tableThere(db: Database.Database, probe: string): boolean {
  try { db.prepare(probe).get(); return true } catch (e) { if (/no such table/i.test((e as Error).message)) return false; throw e }
}
const storeReady = (db: Database.Database): boolean =>
  tableThere(db, 'SELECT 1 AS x FROM scan_jobs LIMIT 1') && tableThere(db, 'SELECT 1 AS x FROM tenant_llm_keys LIMIT 1') && tableThere(db, 'SELECT 1 AS x FROM scan_spend_calls LIMIT 1')

// Work for a kick: a pending scan (to claim), a running one (the kick frees it when its worker died), or a scan's queue
// item still open (a claim whose scan already ended is closed by the next kick). Indexed reads: scan_jobs_status,
// work_queue_claimable. The queue table appears with the first kick; before that there is no queue item to close.
const hasWork = (db: Database.Database): boolean => {
  // a pending scan only when the queue would take it: the same funding rule as the mirror (mirrorScans: a saved key or
  // trial-funded). A keyless scan waits for its account's key; it is not work, or it would be a kick, and a write,
  // every pass for as long as it waits.
  if (db.prepare("SELECT 1 AS x FROM scan_jobs WHERE status = 'running' LIMIT 1").get() !== undefined) return true
  if (db.prepare("SELECT 1 AS x FROM scan_jobs WHERE status = 'pending' AND (user_id IN (SELECT tenant_id FROM tenant_llm_keys) OR funded_by = 'trial') LIMIT 1").get() !== undefined) return true
  try {
    return db.prepare("SELECT 1 AS x FROM work_queue WHERE status IN ('pending', 'claimed') AND kind = 'scan' LIMIT 1").get() !== undefined
  } catch (e) { if (/no such table/i.test((e as Error).message)) return false; throw e }
}

// One pass: kick when the flag is on, the store is set up and there is work. Returns what it did.
export async function workerPass(o: ScanWorkerOpts): Promise<'off' | 'not_ready' | 'idle' | 'kicked'> {
  if (!sharedScanQueue(o.env ?? process.env)) return 'off'
  if (!storeReady(o.db)) return 'not_ready'
  if (!hasWork(o.db)) return 'idle'
  await o.kick(o.db, o.deps)
  return 'kicked'
}

// Runs passes until stop() is called; one pass at a time, intervalMs apart. A pass that throws (a locked store, a
// broken row) is recorded and the loop carries on: the next pass retries.
export function startScanWorker(o: ScanWorkerOpts): { stop: () => void; done: Promise<void> } {
  const interval = o.intervalMs ?? workerIntervalMs(o.env ?? process.env)
  let stopped = false, saidNotReady = false, wake: (() => void) | undefined
  const sleep = () => new Promise<void>(r => { const t = setTimeout(r, interval); wake = () => { clearTimeout(t); r() } })
  const done = (async () => {
    while (!stopped) {
      try {
        const did = await workerPass(o)
        if (did === 'not_ready' && !saidNotReady) { saidNotReady = true; o.log?.('[scan-worker] the store is not set up yet (no scan tables): waiting; the deploy step or the app creates them') }
      } catch (e) {
        captureError(e, { source: 'worker', where: 'scan-worker:pass' })
        o.log?.(`[scan-worker] pass failed: ${e instanceof Error ? e.message.slice(0, 160) : 'error'}`)
      }
      if (!stopped) await sleep()
    }
  })()
  return { stop: () => { stopped = true; wake?.() }, done }
}

// The worker process (scripts/scan-worker.mts): names this instance, opens the app's store (DB_PATH; no scan-table
// migrations, see storeReady), installs the exit
// hook that hands running scans back, and runs the loop until SIGTERM or SIGINT. deps: the runner's own injection
// point, for tests; the script passes none.
//   SCAN_WORKER_ID  this worker's name: work_queue.claimed_by and the journal say worker-<name>; default 8 random hex
// Stopping: process.exit runs the exit hook (lib/scan/shutdown-hook.ts), which returns this worker's running scans and
// their queue claims, so the app or the restarted worker takes them at once. SIGKILL has no exit: the lease returns them.
export function scanWorkerMain(o: { deps?: RunDeps; log?: (line: string) => void } = {}): { stop: () => void; done: Promise<void> } {
  const log = o.log ?? ((line: string) => console.log(line))
  // Always worker-<name>: the env file is shared with the app, so an id set there for the app would otherwise make both
  // processes write the same claimed_by. SCAN_WORKER_ID names this worker; unset or malformed, 8 random hex.
  const named = process.env.SCAN_WORKER_ID
  process.env.DAZL_INSTANCE_ID = 'worker-' + (named && /^[A-Za-z0-9._-]{1,48}$/.test(named) ? named : randomBytes(4).toString('hex'))
  // With DATABASE_URL the queue would be on Postgres while the scan rows stay in this process's SQLite file: not this
  // worker's setup (staging's env check refuses DATABASE_URL). It stays idle and says so.
  const split = !!process.env.DATABASE_URL
  process.env.SCAN_MAX_CONCURRENT = String(workerConcurrency())
  const db = getAuthDb()
  installShutdownRequeue()
  recordProcessErrors()
  const on = sharedScanQueue() && !split
  log(`[scan-worker] started instance=${instanceId()} shared_queue=${on ? 'on' : 'off'} concurrency=${workerConcurrency()} interval_ms=${workerIntervalMs()}`)
  if (split) log('[scan-worker] DATABASE_URL is set: this worker is for the one-file store only: idle, no scan is claimed by this process')
  else if (!on) log('[scan-worker] DAZL_SCAN_SHARED_QUEUE is not 1: idle, no scan is claimed by this process')
  const worker = startScanWorker({ db, kick: kickRunner, deps: o.deps, log, env: split ? { SCAN_WORKER_INTERVAL_MS: process.env.SCAN_WORKER_INTERVAL_MS } : undefined })
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => { log(`[scan-worker] ${sig}: stopping instance=${instanceId()}`); worker.stop(); process.exit(sig === 'SIGTERM' ? 143 : 130) })
  }
  return worker
}
