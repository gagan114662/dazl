import { interruptedTrialAttemptRestored } from '../billing/trial-budget.ts'
import { settleReapedTrialForJob } from '../billing/trial-reap.ts'
import type { Db } from '../db/client.ts'
import { listJobs } from './store-db.ts'
import { effectiveStatus } from './enrichment.ts'
import { recordedEmptyReason, recordedStopRefusalReason } from './outcome-detail.ts'
import { recordedJobCostUsd } from './job-cost.ts'

// The Leads history list (GET /api/scan/jobs): the tenant's own past scans with what their outcome needs.
// Read-only apart from the Z2 read-path settle below (a terminal failed scan's trial reservation).
// funded_by is reported only when it is positive evidence: 'trial' (the shared free-search key; set explicitly when the
// trial scan is created). The column defaults to 'user' for every other row, including rows that existed before the
// column did, so 'user' does not prove whose key a scan used: it is reported as null (unknown) and outcomes word a
// rejected key neutrally.
// On the Db layer: same-second jobs list by id rather than SQLite's insertion order (lib/scan/store-db.ts).
export async function historyJobs(db: Db, userId: string) {
  const jobs = await listJobs(db, userId)
  // Z2 (#1921): the same read-path settle as the status read - a terminal failed scan in this list whose
  // trial reservation was never settled is settled and released before anything is read from it below, so
  // the card, the trial counter and the allowance agree.
  for (const j of jobs) if (j.status === 'failed' && (j.error === 'accounting_uncertain' || j.error === 'provider_rejected' || j.error === 'timeout')) await settleReapedTrialForJob(db, j.id)
  const trial = new Set((await db.all<{ id: string }>("SELECT id FROM scan_jobs WHERE user_id = ? AND funded_by = 'trial'", [userId])).map(r => r.id))
  // A failed read leaves the map empty: no job then claims anything about charges (scan-outcome.ts), and the list still loads.
  const spend = new Map((await db.all<{ id: string; run: number | string | null; cap: number | string | null }>('SELECT id, spend_reserved_usd AS run, spend_cap_reserved_usd AS cap FROM scan_jobs WHERE user_id = ?', [userId]).catch(() => [])).map(r => [r.id, recordedJobCostUsd(r.run, r.cap)]))
  // #1727/#1862: the same recorded-spend truth the status read uses (status-reads.ts readRecordedSpend), for every
  // job at once: still-reserved paid steps that actually started, and what settled calls actually cost. Home's
  // journey reads this same list, so Past scans, Home and Leads phrase the billed claim from the same numbers. A
  // failed read attaches nothing: no job then claims anything about charges.
  const spendCalls = new Map<string, { reservedUsd: number; reservedSteps: number; settledUsd: number; spendRows: number }>()
  let spendCallsRead = true
  try {
    const rows = await db.all<{ id: string; r: number | string | null; n: number | string | null; s: number | string | null; rows: number | string | null }>("SELECT c.scan_job_id AS id, SUM(CASE WHEN c.status = 'reserved' AND c.reserve_usd > 0 THEN c.reserve_usd ELSE 0 END) AS r, COUNT(CASE WHEN c.status = 'reserved' AND c.reserve_usd > 0 THEN 1 END) AS n, SUM(CASE WHEN c.status = 'settled' THEN COALESCE(c.actual_usd, 0) ELSE 0 END) AS s, COUNT(*) AS rows FROM scan_spend_calls c JOIN scan_jobs j ON j.id = c.scan_job_id AND j.user_id = c.user_id WHERE j.user_id = ? GROUP BY c.scan_job_id", [userId])
    for (const row of rows) spendCalls.set(row.id, { reservedUsd: Number(row.r ?? 0), reservedSteps: Number(row.n ?? 0), settledUsd: Number(row.s ?? 0), spendRows: Number(row.rows ?? 0) })
  } catch { spendCallsRead = false }
  return Promise.all(jobs.map(async j => ({
    ...j,
    ...(spendCallsRead ? { settled_usd: spendCalls.get(j.id)?.settledUsd ?? 0, spend_rows: spendCalls.get(j.id)?.spendRows ?? 0, uncertain_usd: (spendCalls.get(j.id)?.reservedSteps ?? 0) > 0 ? spendCalls.get(j.id)!.reservedUsd : null, uncertain_steps: (spendCalls.get(j.id)?.reservedSteps ?? 0) > 0 ? spendCalls.get(j.id)!.reservedSteps : null } : {}),
    // Recorded spend (the job's one cost, job-cost.ts: a positive amount is a paid call), only when it was read (an empty column on a read row = 0; a failed read = omitted): a free scan that stopped at its limit says whether anything was charged (scan-outcome.ts).
    ...(spend.get(j.id) != null ? { spend_usd: spend.get(j.id) } : {}),   // unread or unreadable: left out, never 0
    ...((j.error === 'accounting_uncertain' || j.error === 'provider_rejected') && await interruptedTrialAttemptRestored(db, userId, j.id)
      ? { trial_attempt_restored: true } : {}),
    funded_by: trial.has(j.id) ? 'trial' as const : null,
    status: effectiveStatus(j),
    // Why a scan extracted nothing, as recorded (counts only); null when not recorded or not that outcome.
    empty_reason: await recordedEmptyReason(db, userId, j),
    // The recorded stop provenance (typed report only); null = no reason kept, so a legacy budget_stopped reads neutrally.
    stop_refusal_reason: await recordedStopRefusalReason(db, userId, j),
    // Fixture jobs carry the inserters' own job-level marker (industry/location
    // 'test only') - the same provenance the export filter uses - so a genuine
    // business whose name contains '(test only)' is never mislabeled or hidden.
    test_only: j.industry === 'test only' && j.location === 'test only',
  })))
}

// Home's checklist needs "has any own search been written / finished", which the newest-20 list above cannot prove
// when it is full (20 recent failures can hide an older finished scan). One aggregate over ALL of the tenant's own
// searches: imports (csv_domain) and test fixtures are not plays. Read-only.
export async function historyTotals(db: Db, userId: string): Promise<{ searches: number; finished: number }> {
  const r = await db.get<{ searches: number | string | null; finished: number | string | null }>(
    `SELECT count(*) AS searches, sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS finished FROM scan_jobs
     WHERE user_id = ? AND query IS NOT NULL AND query <> '' AND csv_domain IS NULL
       AND NOT (coalesce(industry, '') = 'test only' AND coalesce(location, '') = 'test only')`, [userId])
  return { searches: Number(r?.searches ?? 0), finished: Number(r?.finished ?? 0) }
}
