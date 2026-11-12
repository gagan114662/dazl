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
import { PROVIDER_FAILURE_STATUSES, ENRICH_SKIP_STATUSES, SPEND_REFUSAL_PREFIX } from './provider-issue-text.ts'
import type { ProviderIssue, ProviderFailureStatus, EnrichSkipStatus } from './provider-issue-text.ts'
export type { ProviderIssue, ProviderFailureStatus, EnrichSkipStatus }
import { getDb, type Db } from '../db/client.ts'
import { parseRefusalLookup } from '../enrich/credit-pool.ts'

// null = the audit table could not be read (older DB without it, or any read failure): the scan
// view renders an explicit "provider record not available, not an all-clear" notice for it (see
// scan-provider-issues-unknown in leads-client), never silence that reads as "no issues".
// [] = read succeeded, no failures - the only state allowed to look quiet.
export async function providerIssues(tenantId: string, jobId: string): Promise<ProviderIssue[] | null> {
  try { return await readProviderIssues(await getDb(), tenantId, jobId) } catch { return null }
}

// Injected-store reader: scan status must not independently select another database for provider audit.
export async function readProviderIssues(db: Db, tenantId: string, jobId: string): Promise<ProviderIssue[] | null> {
  try {
    // Enrichment skips (budget, circuit, held, fallback off) count only on the enrichment connectors.
    const rows = await db.all<{ connector: string; status: ProviderFailureStatus | EnrichSkipStatus; n: number | string; latest: number | string }>(
      `SELECT connector, status, count(*) AS n, max(created_at) AS latest FROM connector_audit
       WHERE tenant_id = ? AND scan_job_id = ? AND (status IN (${PROVIDER_FAILURE_STATUSES.map(() => '?').join(',')})
         OR (connector IN ('enrich:apollo','enrich:pdl') AND status IN (${ENRICH_SKIP_STATUSES.map(() => '?').join(',')})))
       GROUP BY connector, status ORDER BY latest DESC`,
      [tenantId, jobId, ...PROVIDER_FAILURE_STATUSES, ...ENRICH_SKIP_STATUSES],
    )
    const issues: ProviderIssue[] = rows.map(r => ({ connector: r.connector, status: r.status, lookups_affected: Number(r.n), latest_at: Number(r.latest) }))
    // A credit_cap carries the numbers the refusing window had AT the refusal (stored on its audit row), never a later re-read.
    for (const i of issues) {
      if (i.status !== 'credit_cap') continue
      try {
        const row = await db.get<{ lookup: string }>(`SELECT lookup FROM connector_audit WHERE tenant_id = ? AND scan_job_id = ? AND connector = ? AND status = 'credit_cap' ORDER BY created_at DESC LIMIT 1`, [tenantId, jobId, i.connector])
        const c = row ? parseRefusalLookup(row.lookup) : null
        if (c) i.credit = c
      } catch { /* numbers omitted: the sentence then names no window */ }
    }
    // A spend refusal carries the gate's reason on its skip row (SPEND_REFUSAL_PREFIX + reason), never a later re-read. Each cause
    // is its own notice: a scan pass refused for one reason and an owner retry refused for another are two lines, never one line
    // naming whichever row came last.
    const out: ProviderIssue[] = []
    for (const i of issues) {
      if (i.status !== 'spend_refused') { out.push(i); continue }
      try {
        const byReason = await db.all<{ lookup: string; n: number | string; latest: number | string }>(
          `SELECT lookup, count(*) AS n, max(created_at) AS latest FROM connector_audit WHERE tenant_id = ? AND scan_job_id = ? AND connector = ? AND status = 'spend_refused' GROUP BY lookup ORDER BY latest DESC, lookup`,
          [tenantId, jobId, i.connector])
        if (!byReason.length) { out.push(i); continue }
        for (const r of byReason) out.push({ ...i, lookups_affected: Number(r.n), latest_at: Number(r.latest), ...(r.lookup.startsWith(SPEND_REFUSAL_PREFIX) ? { refusal: r.lookup.slice(SPEND_REFUSAL_PREFIX.length) } : {}) })
      } catch { out.push(i) /* reason omitted: the sentence then says the spend check refused it, without a reason */ }
    }
    return out
  } catch {
    return null
  }
}
