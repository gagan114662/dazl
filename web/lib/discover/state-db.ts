// Reads the discovery leads of some searches and gives each its ONE state (lib/discover/card.ts discoverState). This is the only place
// the server-side counters (the Leads header, past scans, the Campaigns list, a campaign's page, the spreadsheet) get a discovery lead's
// state from, so they cannot disagree (#1238, #684, #1062). Read-only and workspace-scoped: only the signed-in workspace's own searches and rows.
// On the Db layer (SQLite or Postgres). A caller still on the synchronous store runs discoverStoredSql itself and hands the rows over.
//
// The state needs one fact the lead's own rows do not carry: the verdict on the person's address (a personal mailbox, the workspace's
// do-not-contact list, a press inbox, a failed mailbox check). The counters used to leave it out, so a lead whose card said "Can't
// approve yet" was counted ready (#1238). It is now a REQUIRED argument of discoverStatesFromRows, built by discoverRefusals from
// the same stored rows and the same pure rule the draft check applies (lib/outreach/recipient-rule.ts).
import type { Db } from '../db/client.ts'
import { captureError } from '../ops/errors.ts'
import { PUBLISHED_EMAIL_RE } from '../outreach/published-email.ts'
import { addressAllowed, isDesignatedTestTenant, recipientVerdict, type RecipientRefusal } from '../outreach/recipient-rule.ts'
import { discoverContact, discoverCounts, discoverState, type DiscoverCounts, type DiscoverState } from './card.ts'

// The columns of a lead its state is read from, for a caller that reads the workspace's own lead rows itself (aliased `l`).
export const DISCOVER_LEAD_COLUMNS = 'l.name, l.company_domain, l.event_date, l.fit, l.intent, l.source_kind'
export type DiscoverLeadRow = { id: string; scan_job_id: string; name: string | null; company_domain: string | null; review_reason: string | null; event_date: string | null; fit: number | null; intent: number | null; quarantined_at: number | null; source_kind?: string | null }
export type DiscoverStoredRow = { lead_id: string; kind: string; connector: string; value: string; source_url: string | null; retrieved_at?: number | null }
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',')
const leadsSql = (n: number) => `SELECT l.id, l.scan_job_id, l.review_reason, l.quarantined_at, ${DISCOVER_LEAD_COLUMNS}
  FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE l.scan_job_id IN (${marks(n)}) AND l.source_kind = 'discover'`
// The rows stored for the leads of n searches, oldest first (the order the card and the draft check read them in): what the run stored
// (the person, the address, the profile) and every recorded mailbox check of the lead (kind 'deliverability', whoever recorded it).
// Parameters: the workspace, the workspace again, then the n search ids.
export const discoverStoredSql = (n: number) => `SELECT e.lead_id, e.kind, e.connector, e.value, e.source_url, e.retrieved_at FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id
  JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE e.tenant_id = ? AND l.scan_job_id IN (${marks(n)}) AND l.source_kind = 'discover'
  AND ((e.connector = 'discover' AND e.kind IN ('person', 'email', 'linkedin')) OR e.kind = 'deliverability') AND e.value != '' ORDER BY e.retrieved_at, e.id`
// A store that predates the table simply has no stored rows.
const MISSING = /no such table|does not exist/i
export const discoverNoTable = (e: unknown): DiscoverStoredRow[] => { if (MISSING.test(String((e as Error)?.message))) return []; throw e }

const byLeadOf = (stored: DiscoverStoredRow[]) => {
  const byLead = new Map<string, DiscoverStoredRow[]>()
  for (const r of stored) byLead.set(r.lead_id, [...(byLead.get(r.lead_id) ?? []), r])
  return byLead
}
type NamedLead = { id: string; name: string | null; source_kind?: string | null }
// The address a draft to each discovery lead would go to: the named person's own (lib/discover/card.ts discoverContact). A lead with
// none has no entry.
export function discoverOwnAddresses(rows: NamedLead[], stored: DiscoverStoredRow[]): Map<string, string> {
  const byLead = byLeadOf(stored), out = new Map<string, string>()
  for (const l of rows) {
    if (l.source_kind !== 'discover') continue
    const to = discoverContact({ source_kind: 'discover', name: l.name, enrichments: byLead.get(l.id) ?? [] })?.email?.address ?? ''
    if (PUBLISHED_EMAIL_RE.test(to)) out.set(l.id, to)
  }
  return out
}
// What a reader knows about addresses beyond the stored rows. null: it could not be read, and every lead with an address is then
// 'unreadable' (never "not refused": review of #1578).
export interface RecipientFacts { allowed(email: string): boolean; suppressed(email: string): boolean }
// lead id -> why a draft to its person's own address would be refused. A lead that is not refused, or has no address, has no entry.
export function discoverRefusals(rows: NamedLead[], stored: DiscoverStoredRow[], facts: RecipientFacts | null): Map<string, RecipientRefusal> {
  const byLead = byLeadOf(stored), out = new Map<string, RecipientRefusal>()
  for (const [id, to] of discoverOwnAddresses(rows, stored)) {
    const v = facts ? recipientVerdict(to, { allowed: facts.allowed(to), suppressed: facts.suppressed(to), rows: byLead.get(id) ?? [] }) : 'unreadable'
    if (v) out.set(id, v)
  }
  return out
}

// lead id -> state, per search. A search with no discovery lead has no entry. Rows that are not discovery leads are ignored.
export type DiscoverStates = Map<string, Map<string, DiscoverState>>
// refused: discoverRefusals over these same rows. Required, so no counter can leave the address verdict out.
export function discoverStatesFromRows(rows: DiscoverLeadRow[], stored: DiscoverStoredRow[], refused: ReadonlyMap<string, RecipientRefusal>): DiscoverStates {
  const byLead = byLeadOf(stored)
  const out: DiscoverStates = new Map()
  for (const l of rows) {
    if (l.source_kind !== 'discover') continue
    const job = out.get(l.scan_job_id) ?? new Map<string, DiscoverState>()
    // gate_held: the required check of the older engine never applies to a discovery lead (lib/scan/held-state.ts answers null for one)
    job.set(l.id, discoverState({ ...l, gate_held: false, enrichments: byLead.get(l.id) ?? [], recipient_refused: refused.get(l.id) ?? null }))
    out.set(l.scan_job_id, job)
  }
  return out
}
const CHUNK = 400
// The do-not-contact list and the test-inbox allowlist for these addresses, on the Db layer. A read that fails is recorded and answers
// null. Only a store that predates the allowlist table reads as "no allowlist", as the synchronous reader does (lib/outreach/service.ts).
async function recipientFactsOfDb(db: Db, tenantId: string, addresses: string[]): Promise<RecipientFacts | null> {
  try {
    const listed = new Set<string>()
    for (let i = 0; i < addresses.length; i += CHUNK) {
      const part = addresses.slice(i, i + CHUNK)
      for (const r of await db.all<{ email: string }>(`SELECT email FROM suppressions WHERE tenant_id = ? AND email IN (${marks(part.length)})`, [tenantId, ...part])) listed.add(r.email)
    }
    let allow: string[] = []
    if (addresses.length && isDesignatedTestTenant(tenantId)) {
      let saved: { test_addresses: string } | undefined
      try { saved = await db.get<{ test_addresses: string }>('SELECT test_addresses FROM sequence_settings WHERE tenant_id = ?', [tenantId]) } catch (e) { if (!MISSING.test(String((e as Error)?.message))) throw e }
      try { allow = (JSON.parse(saved?.test_addresses ?? '[]') as string[]).map(a => a.trim().toLowerCase()) } catch { allow = [] }
    }
    return { suppressed: email => listed.has(email), allowed: email => addressAllowed(tenantId, email, () => allow.includes(email)) }
  } catch (e) {
    captureError(e, { source: 'route', where: 'lib/discover/state-db', tenantId })
    return null
  }
}
// The states AND the address verdicts they were computed with, from one read: a page that also shows each lead (GET /api/leads) sends
// the verdict with the lead, so the card and the count beside it are the same answer.
export interface DiscoverRead { states: DiscoverStates; refused: Map<string, RecipientRefusal> }
// For a caller that has already read the lead rows: two more reads (the stored rows, the do-not-contact list), and none when no row is a discovery lead.
export async function discoverReadOfDb(db: Db, tenantId: string, rows: DiscoverLeadRow[]): Promise<DiscoverRead> {
  const jobIds = [...new Set(rows.filter(r => r.source_kind === 'discover').map(r => r.scan_job_id))]
  if (!jobIds.length) return { states: new Map(), refused: new Map() }
  let stored: DiscoverStoredRow[]
  try { stored = await db.all<DiscoverStoredRow>(discoverStoredSql(jobIds.length), [tenantId, tenantId, ...jobIds]) } catch (e) { stored = discoverNoTable(e) }
  const refused = discoverRefusals(rows, stored, await recipientFactsOfDb(db, tenantId, [...new Set(discoverOwnAddresses(rows, stored).values())]))
  return { states: discoverStatesFromRows(rows, stored, refused), refused }
}
export async function discoverReadForDb(db: Db, tenantId: string, jobIds: string[]): Promise<DiscoverRead> {
  if (!jobIds.length) return { states: new Map(), refused: new Map() }
  return discoverReadOfDb(db, tenantId, await db.all<DiscoverLeadRow>(leadsSql(jobIds.length), [tenantId, ...jobIds]))
}
export const discoverStatesOfDb = async (db: Db, tenantId: string, rows: DiscoverLeadRow[]): Promise<DiscoverStates> => (await discoverReadOfDb(db, tenantId, rows)).states
export const discoverStatesForDb = async (db: Db, tenantId: string, jobIds: string[]): Promise<DiscoverStates> => (await discoverReadForDb(db, tenantId, jobIds)).states
// One search's counts; null when it has no discovery lead (an older search keeps its own counts).
export async function discoverJobCounts(db: Db, tenantId: string, jobId: string): Promise<DiscoverCounts | null> {
  const s = (await discoverStatesForDb(db, tenantId, [jobId])).get(jobId)
  return s ? discoverCounts(s.values()) : null
}
