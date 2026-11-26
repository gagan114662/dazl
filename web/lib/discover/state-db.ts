// Reads the discovery leads of some searches and gives each its ONE state (lib/discover/card.ts discoverState). This is the only place
// the server-side counters (the Leads header, past scans, the Campaigns list, a campaign's page) get a discovery lead's state from, so
// they cannot disagree (#1238, #684, #1062). Read-only and workspace-scoped: only the signed-in workspace's own searches and rows.
// On the Db layer (SQLite or Postgres). A caller still on the synchronous store runs discoverStoredSql itself and hands the rows over.
import type { Db } from '../db/client.ts'
import { discoverCounts, discoverState, type DiscoverCounts, type DiscoverState } from './card.ts'

// The columns of a lead its state is read from, for a caller that reads the workspace's own lead rows itself (aliased `l`).
export const DISCOVER_LEAD_COLUMNS = 'l.name, l.company_domain, l.event_date, l.timing_note, l.fit, l.intent, l.source_kind'
export type DiscoverLeadRow = { id: string; scan_job_id: string; name: string | null; company_domain: string | null; review_reason: string | null; event_date: string | null; timing_note?: string | null; fit: number | null; intent: number | null; quarantined_at: number | null; source_kind?: string | null }
export type DiscoverStoredRow = { lead_id: string; kind: string; connector: string; value: string; source_url: string | null }
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',')
const leadsSql = (n: number) => `SELECT l.id, l.scan_job_id, l.review_reason, l.quarantined_at, ${DISCOVER_LEAD_COLUMNS}
  FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE l.scan_job_id IN (${marks(n)}) AND l.source_kind = 'discover'`
// The rows the run stored for the leads of n searches (the person, the address, the profile), oldest first: the order the card and the
// draft check read them in. Parameters: the workspace, the workspace again, then the n search ids.
export const discoverStoredSql = (n: number) => `SELECT e.lead_id, e.kind, e.connector, e.value, e.source_url FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id
  JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE e.tenant_id = ? AND l.scan_job_id IN (${marks(n)}) AND l.source_kind = 'discover'
  AND e.connector = 'discover' AND e.kind IN ('person', 'email', 'linkedin') AND e.value != '' ORDER BY e.retrieved_at, e.id`
// A store that predates the table simply has no stored rows.
export const discoverNoTable = (e: unknown): DiscoverStoredRow[] => { if (/no such table|does not exist/i.test(String((e as Error)?.message))) return []; throw e }

// lead id -> state, per search. A search with no discovery lead has no entry. Rows that are not discovery leads are ignored.
export type DiscoverStates = Map<string, Map<string, DiscoverState>>
export function discoverStatesFromRows(rows: DiscoverLeadRow[], stored: DiscoverStoredRow[]): DiscoverStates {
  const byLead = new Map<string, DiscoverStoredRow[]>()
  for (const r of stored) byLead.set(r.lead_id, [...(byLead.get(r.lead_id) ?? []), r])
  const out: DiscoverStates = new Map()
  for (const l of rows) {
    if (l.source_kind !== 'discover') continue
    const job = out.get(l.scan_job_id) ?? new Map<string, DiscoverState>()
    // gate_held: the required check of the older engine never applies to a discovery lead (lib/scan/held-state.ts answers null for one)
    job.set(l.id, discoverState({ ...l, gate_held: false, enrichments: byLead.get(l.id) ?? [] }))
    out.set(l.scan_job_id, job)
  }
  return out
}
// For a caller that has already read the lead rows: one more read, and none when no row is a discovery lead.
export async function discoverStatesOfDb(db: Db, tenantId: string, rows: DiscoverLeadRow[]): Promise<DiscoverStates> {
  const jobIds = [...new Set(rows.filter(r => r.source_kind === 'discover').map(r => r.scan_job_id))]
  if (!jobIds.length) return new Map()
  let stored: DiscoverStoredRow[]
  try { stored = await db.all<DiscoverStoredRow>(discoverStoredSql(jobIds.length), [tenantId, tenantId, ...jobIds]) } catch (e) { stored = discoverNoTable(e) }
  return discoverStatesFromRows(rows, stored)
}
export async function discoverStatesForDb(db: Db, tenantId: string, jobIds: string[]): Promise<DiscoverStates> {
  if (!jobIds.length) return new Map()
  return discoverStatesOfDb(db, tenantId, await db.all<DiscoverLeadRow>(leadsSql(jobIds.length), [tenantId, ...jobIds]))
}
// One search's counts; null when it has no discovery lead (an older search keeps its own counts).
export async function discoverJobCounts(db: Db, tenantId: string, jobId: string): Promise<DiscoverCounts | null> {
  const s = (await discoverStatesForDb(db, tenantId, [jobId])).get(jobId)
  return s ? discoverCounts(s.values()) : null
}
