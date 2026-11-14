// One matrix case through the real scan pipeline (createQueryJob -> claimKeyedJob -> runJob), on a store that has every table the
// app's own scan store has (migrateAllSqlite), under the case's own run budget (max_usd, enforced by the scan spend ledger before
// every paid call). Used by matrix-local.mts; its own tests run it with stubbed providers (test/matrix-score-1099.test.ts).
import type Database from 'better-sqlite3'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob, type RunDeps } from '../lib/scan/runner.ts'
import { measureCase, verdict, funnelOf, type CaseResult, type MatrixCase, type MatrixThresholds } from './matrix-score.mts'

// A scan that did not finish cleanly is INCOMPLETE and never passes, whatever it had found by then.
const INCOMPLETE = new Set(['budget_stopped', 'scan_timeout', 'key_rejected', 'key_unreadable', 'no_api_key', 'accounting_uncertain', 'not_claimed'])

// The seller line as staging builds it (lib/auth-db.ts sellerLine): what the seller sells, then its website. A matrix case has an
// offer and no website, so the line is the offer; the brand name is not part of it.
export const sellerLineFor = (c: MatrixCase): string => (c.offer ?? c.seller ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)

// what the scan really cost: settled calls at their vendor-reported cost, reserved ones at their worst case; a call the cap
// refused was never sent, so its recorded worst case is not spend
export function spentUsd(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT round(sum(coalesce(actual_usd, reserve_usd)), 4) AS usd FROM scan_spend_calls WHERE scan_job_id = ? AND status <> 'refused'").get(jobId) as { usd: number | null }).usd ?? 0
}

export async function runCase(db: Database.Database, c: MatrixCase, o: { tenant: string; cap: number; timeoutS: number; thresholds: MatrixThresholds; deps?: RunDeps; now?: Date }): Promise<CaseResult> {
  const t0 = Date.now()
  const id = createQueryJob(db, o.tenant, { query: c.query, seller: sellerLineFor(c), offer: c.offer ?? null, runBudget: JSON.stringify({ max_usd: o.cap }) })
  const job = claimKeyedJob(db, id)
  let error: string | null = null
  let crashed = false
  if (!job) error = 'not_claimed'
  else {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        runJob(db, job, o.deps ?? {}).then(() => 'ran' as const),
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), o.timeoutS * 1000) }),
      ])
      if (outcome === 'timeout') {
        error = 'scan_timeout'
        // stop the abandoned run: a failed job refuses every later paid reservation (scan_not_active), so it cannot keep spending
        // while the next case runs, and what is measured below is final
        db.prepare("UPDATE scan_jobs SET status = 'failed', error = 'scan_timeout' WHERE id = ? AND status = 'running'").run(id)
      }
    } catch (e) { error = `crashed: ${String((e as Error)?.message ?? e).slice(0, 120)}`; crashed = true }
    finally { if (timer) clearTimeout(timer) }
  }
  const j = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null }
  error = error ?? j.error
  const usd = spentUsd(db, id)
  const m = measureCase(db, o.tenant, id, c, o.now)
  const v = verdict(m, o.thresholds)
  // done and failed are the only finished states: pending/running (a retry that never came, a stopped run) are INCOMPLETE too
  const incomplete = crashed || (error !== null && INCOMPLETE.has(error)) || (j.status !== 'done' && j.status !== 'failed')
  return { id: c.id, label: c.label, status: incomplete ? 'INCOMPLETE' : j.status, error, ...m, seconds: Math.round((Date.now() - t0) / 1000), usd, pass: v.pass && !incomplete && j.status === 'done', why: v.why, funnel: funnelOf(db, id) }
}
