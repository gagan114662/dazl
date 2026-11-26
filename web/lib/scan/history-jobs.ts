import { interruptedTrialAttemptRestored } from '../billing/trial-budget.ts'
import type { Db } from '../db/client.ts'
import { listJobs } from './store-db.ts'
import { effectiveStatus } from './enrichment.ts'
import { recordedEmptyReason, recordedStopRefusalReason } from './outcome-detail.ts'
import { recordedJobCostUsd } from './job-cost.ts'

// The Leads history list (GET /api/scan/jobs): the tenant's own past scans with what their outcome needs. Read-only.
// funded_by is reported only when it is positive evidence: 'trial' (the shared free-search key; set explicitly when the
// trial scan is created). The column defaults to 'user' for every other row, including rows that existed before the
// column did, so 'user' does not prove whose key a scan used: it is reported as null (unknown) and outcomes word a
// rejected key neutrally.
// On the Db layer: same-second jobs list by id rather than SQLite's insertion order (lib/scan/store-db.ts).
export async function historyJobs(db: Db, userId: string) {
  const trial = new Set((await db.all<{ id: string }>("SELECT id FROM scan_jobs WHERE user_id = ? AND funded_by = 'trial'", [userId])).map(r => r.id))
  // A failed read leaves the map empty: no job then claims anything about charges (scan-outcome.ts), and the list still loads.
  const spend = new Map((await db.all<{ id: string; run: number | string | null; cap: number | string | null }>('SELECT id, spend_reserved_usd AS run, spend_cap_reserved_usd AS cap FROM scan_jobs WHERE user_id = ?', [userId]).catch(() => [])).map(r => [r.id, recordedJobCostUsd(r.run, r.cap)]))
  const jobs = await Promise.all((await listJobs(db, userId)).map(async j => ({
    ...j,
    // Recorded spend (the job's one cost, job-cost.ts: a positive amount is a paid call), only when it was read (an empty column on a read row = 0; a failed read = omitted): a free scan that stopped at its limit says whether anything was charged (scan-outcome.ts).
    ...(spend.get(j.id) != null ? { spend_usd: spend.get(j.id) } : {}),   // unread or unreadable: left out, never 0
    ...(j.error === 'accounting_uncertain' && await interruptedTrialAttemptRestored(db, userId, j.id)
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
  // #1849: one scan recorded twice (two scan_jobs rows for a single run) listed twice in Past scans while Plays,
  // which groups by search, listed it once. Rows are the same scan in substance only when everything this list
  // shows about them matches AND they were created in the same second — the double-record signature: collapse
  // those to the row that carries the leads. Rows that merely share a search are real, separate runs (each its
  // own billed record) and all stay; the card shows the run time so they can be told apart.
  const seen = new Map<string, number>()
  const deduped: typeof jobs = []
  for (const j of jobs) {
    const key = [j.query ?? '', j.csv_domain ?? '', j.business_name ?? '', j.created_at, j.status].join('|')
    const at = seen.get(key)
    if (at === undefined) { seen.set(key, deduped.length); deduped.push(j) }
    else if ((j.lead_count ?? 0) > (deduped[at].lead_count ?? 0)) deduped[at] = j
  }
  return deduped
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
