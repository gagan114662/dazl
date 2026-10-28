import type { Db } from '../db/client.ts'
import { listJobs } from './store-db.ts'
import { effectiveStatus } from './enrichment.ts'
import { recordedEmptyReason } from './outcome-detail.ts'

// The Leads history list (GET /api/scan/jobs): the tenant's own past scans with what their outcome needs. Read-only.
// funded_by is reported only when it is positive evidence: 'trial' (the shared free-search key; set explicitly when the
// trial scan is created). The column defaults to 'user' for every other row, including rows that existed before the
// column did, so 'user' does not prove whose key a scan used: it is reported as null (unknown) and outcomes word a
// rejected key neutrally.
// On the Db layer: same-second jobs list by id rather than SQLite's insertion order (lib/scan/store-db.ts).
export async function historyJobs(db: Db, userId: string) {
  const trial = new Set((await db.all<{ id: string }>("SELECT id FROM scan_jobs WHERE user_id = ? AND funded_by = 'trial'", [userId])).map(r => r.id))
  return Promise.all((await listJobs(db, userId)).map(async j => ({
    ...j,
    funded_by: trial.has(j.id) ? 'trial' as const : null,
    status: effectiveStatus(j),
    // Why a scan extracted nothing, as recorded (counts only); null when not recorded or not that outcome.
    empty_reason: await recordedEmptyReason(db, userId, j),
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
