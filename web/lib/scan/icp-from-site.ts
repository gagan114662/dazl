// One matrix case through the real scan pipeline (createQueryJob -> claimKeyedJob -> runJob), on a store that has every table the
// app's own scan store has (migrateAllSqlite), under the case's own run budget (max_usd, enforced by the scan spend ledger before
// every paid call). Used by matrix-local.mts; its own tests run it with stubbed providers (test/matrix-score-1099.test.ts).
import type Database from 'better-sqlite3'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob, type RunDeps } from '../lib/scan/runner.ts'
import { scanCapConfig } from '../lib/scan/spend-cap.ts'
import { measureCase, verdict, type CaseResult, type MatrixCase, type MatrixThresholds } from './matrix-score.mts'

// A scan that did not finish cleanly is INCOMPLETE and never passes, whatever it had found by then.
const INCOMPLETE = new Set(['budget_stopped', 'scan_timeout', 'key_rejected', 'key_unreadable', 'no_api_key', 'accounting_uncertain', 'not_claimed', 'cap_not_enforced'])

// The seller line as staging builds it (lib/auth-db.ts sellerLine): what the seller sells, then its website. A matrix case has an
// offer and no website, so the line is the offer; the brand name is not part of it.
export const sellerLineFor = (c: MatrixCase): string => (c.offer ?? c.seller ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)

// what the scan really cost: settled calls at their vendor-reported cost, reserved ones at their worst case; a call the cap
// refused was never sent, so its recorded worst case is not spend
export function spentUsd(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT round(sum(coalesce(actual_usd, reserve_usd)), 4) AS usd FROM scan_spend_calls WHERE scan_job_id = ? AND status <> 'refused'").get(jobId) as { usd: number | null }).usd ?? 0
}

// Two ways to hold a case to its cap:
//  - budget (default): the job carries its own run budget (max_usd). The runner then switches the paid contact pass (the
//    tenant's Apollo/PDL keys) OFF for that run (runner.ts: "a budgeted run adds no other paid enrichment"), so named % and
//    email % never include Apollo/PDL contacts.
//  - contacts: NO run dollar limit on the job, as in Hermes's staging matrix, so the contact pass runs. The cap is then the
//    scan spend ledger's own per-scan cap (DAZL_SCAN_CAP_CAD, checked before every paid call, Apollo/PDL included), which the
//    caller must have set to this case's cap: runCase refuses to run otherwise (cap_not_enforced). A watchdog also stops the
//    job the moment its recorded spend reaches the cap.
export async function runCase(db: Database.Database, c: MatrixCase, o: { tenant: string; cap: number; timeoutS: number; thresholds: MatrixThresholds; deps?: RunDeps; now?: Date; contacts?: boolean; env?: Record<string, string | undefined>; run?: typeof runJob }): Promise<CaseResult> {
  const t0 = Date.now()
  const never = (error: string): CaseResult => ({ id: c.id, label: c.label, status: 'INCOMPLETE', error, candidates: 0, leads: 0, ready: 0, named_pct: 0, email_pct: 0, dated_pct: 0, match_pct: 0, held: {}, seconds: 0, usd: null, pass: false, why: [] })
  if (o.contacts) {
    const cfg = scanCapConfig(o.env ?? process.env)
    if (!cfg.ok || cfg.capUsd > o.cap + 1e-9) return never('cap_not_enforced')   // nothing is created, nothing is sent
  }
  const id = createQueryJob(db, o.tenant, { query: c.query, seller: sellerLineFor(c), offer: c.offer ?? null, runBudget: o.contacts ? null : JSON.stringify({ max_usd: o.cap }) })
  const job = claimKeyedJob(db, id)
  let error: string | null = null
  let crashed = false
  if (!job) error = 'not_claimed'
  else {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = (why: string) => db.prepare("UPDATE scan_jobs SET status = 'failed', error = ? WHERE id = ? AND status = 'running'").run(why, id).changes === 1
    const watchdog = o.contacts ? setInterval(() => { if (spentUsd(db, id) >= o.cap && stop('budget_stopped')) error = 'budget_stopped' }, 500) : undefined
    try {
      const outcome = await Promise.race([
        (o.run ?? runJob)(db, job, o.deps ?? {}).then(() => 'ran' as const),
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), o.timeoutS * 1000) }),
      ])
      if (outcome === 'timeout') {
        error = 'scan_timeout'
        // stop the abandoned run: a failed job refuses every later paid reservation (scan_not_active), so it cannot keep spending
        // while the next case runs, and what is measured below is final
        stop('scan_timeout')
      }
    } catch (e) { error = `crashed: ${String((e as Error)?.message ?? e).slice(0, 120)}`; crashed = true }
    finally { if (timer) clearTimeout(timer); if (watchdog) clearInterval(watchdog) }
  }
  const j = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null }
  error = error ?? j.error
  const usd = job ? spentUsd(db, id) : null   // a case that never ran has no measured cost: the table prints ?, never 0
  const m = measureCase(db, o.tenant, id, c, o.now)
  const v = verdict(m, o.thresholds)
  // done and failed are the only finished states: pending/running (a retry that never came, a stopped run) are INCOMPLETE too
  const incomplete = crashed || (error !== null && INCOMPLETE.has(error)) || (j.status !== 'done' && j.status !== 'failed')
  return { id: c.id, label: c.label, status: incomplete ? 'INCOMPLETE' : j.status, error, ...m, seconds: Math.round((Date.now() - t0) / 1000), usd, pass: v.pass && !incomplete && j.status === 'done', why: v.why }
}
