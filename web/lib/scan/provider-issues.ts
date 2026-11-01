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
export { PROVIDER_FAILURE_STATUSES, providerIssueText } from './provider-issue-text.ts'
import type { ProviderIssue, ProviderFailureStatus } from './provider-issue-text.ts'
export type { ProviderIssue, ProviderFailureStatus }
import { getDb } from '../db/client.ts'

// null = the audit table could not be read (older DB without it, or any read failure): the scan
// view renders an explicit "provider record not available, not an all-clear" notice for it (see
// scan-provider-issues-unknown in leads-client), never silence that reads as "no issues".
// [] = read succeeded, no failures - the only state allowed to look quiet.
export async function providerIssues(tenantId: string, jobId: string): Promise<ProviderIssue[] | null> {
  try {
    const db = await getDb()
    const rows = await db.all<{ connector: string; status: ProviderFailureStatus; n: number | string; latest: number | string }>(
      `SELECT connector, status, count(*) AS n, max(created_at) AS latest FROM connector_audit
       WHERE tenant_id = ? AND scan_job_id = ? AND status IN ('auth','rate_limited','upstream','error')
       GROUP BY connector, status ORDER BY latest DESC`,
      [tenantId, jobId],
    )
    return rows.map(r => ({ connector: r.connector, status: r.status, lookups_affected: Number(r.n), latest_at: Number(r.latest) }))
  } catch {
    return null
  }
}
