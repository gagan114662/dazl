// Provider failures DURING a scan, surfaced in the scan view. The enrichment waterfall treats a
// failed provider call as a missing bonus, not an error, and records every attempt in
// connector_audit (lib/connectors/store.ts) with the EnrichError code as its status. Until now
// those rows were only visible in Settings > Enrichment (last 8 across ALL scans), so a rejected
// or rate-limited key mid-scan left the scan looking normally "done". This read puts the same
// recorded facts beside the scan they belong to. Read-only; never includes the lookup text
// (company names) or any key material - connector, status, count, latest time only.
// On the Db layer (lib/db/client.ts): the same SQL runs on SQLite today and Postgres after the
// cutover. created_at is an epoch integer in both dialects; count(*) comes back as a string from
// the pg driver, so both aggregates go through Number().
export { PROVIDER_FAILURE_STATUSES, ENRICH_SKIP_STATUSES, providerIssueText } from './provider-issue-text.ts'
import { PROVIDER_FAILURE_STATUSES, ENRICH_SKIP_STATUSES } from './provider-issue-text.ts'
import type { ProviderIssue, ProviderFailureStatus, EnrichSkipStatus } from './provider-issue-text.ts'
export type { ProviderIssue, ProviderFailureStatus, EnrichSkipStatus }
import { getDb } from '../db/client.ts'
import { creditUse } from '../enrich/credit-pool.ts'

// null = the audit table could not be read (older DB without it, or any read failure): the scan
// view renders an explicit "provider record not available, not an all-clear" notice for it (see
// scan-provider-issues-unknown in leads-client), never silence that reads as "no issues".
// [] = read succeeded, no failures - the only state allowed to look quiet.
export async function providerIssues(tenantId: string, jobId: string): Promise<ProviderIssue[] | null> {
  try {
    const db = await getDb()
    // Enrichment skips (budget, circuit, held, fallback off) count only on the enrichment connectors.
    const rows = await db.all<{ connector: string; status: ProviderFailureStatus | EnrichSkipStatus; n: number | string; latest: number | string }>(
      `SELECT connector, status, count(*) AS n, max(created_at) AS latest FROM connector_audit
       WHERE tenant_id = ? AND scan_job_id = ? AND (status IN (${PROVIDER_FAILURE_STATUSES.map(() => '?').join(',')})
         OR (connector IN ('enrich:apollo','enrich:pdl') AND status IN (${ENRICH_SKIP_STATUSES.map(() => '?').join(',')})))
       GROUP BY connector, status ORDER BY latest DESC`,
      [tenantId, jobId, ...PROVIDER_FAILURE_STATUSES, ...ENRICH_SKIP_STATUSES],
    )
    const issues: ProviderIssue[] = rows.map(r => ({ connector: r.connector, status: r.status, lookups_affected: Number(r.n), latest_at: Number(r.latest) }))
    // A credit_cap names the window that is full and the credits used against it, read now from the pool (best effort:
    // the sentence still says the limit was reached without the numbers if the read fails).
    for (const i of issues) {
      if (i.status !== 'credit_cap') continue
      try {
        const prov = i.connector === 'enrich:pdl' ? 'pdl' : 'apollo'
        // The refused window is not always full: a 5-credit PDL batch is refused at 0 used of 4. Name the tightest limited window (least headroom).
        const lim = (await creditUse(db, tenantId)).filter(u => u.provider === prov && u.limit !== null).sort((a, b) => (a.limit! - a.reserved) - (b.limit! - b.reserved))
        const u = lim[0]; if (u) i.credit = { window: u.window, used: u.reserved, limit: u.limit! }
      } catch { /* numbers omitted */ }
    }
    return issues
  } catch {
    return null
  }
}
