// #1037: can a person's review still give a lead its buyer? The ONE answer every page that splits held leads into "review" and "research"
// counts by (Home heldState, the Campaigns list and history, the campaign page, a run's current split - all through lib/lead-state.ts
// reviewIsActionable), so no page calls a lead a review item that no review can make ready.
// Checking the source never names a buyer. Confirming the website can: a review names the buyer only when the buyer is already named
// (leadPerson on the lead's site identity) or the real buyer rule accepts a stored person once the still-unconfirmed site is confirmed. Read from the lead's stored rows only; tenant-scoped; batched for list readers.
import type { Db } from '../db/client.ts'
import { leadPerson } from './lead-person.ts'
import { identityOf } from '../scan/opportunity.ts'

type Row = { kind: string; value: string; label: string | null; source_url: string; connector: string; retrieved_at?: unknown }
const num = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : v

export function reviewCanNameBuyer(lead: { id: string; contact: string | null }, rows: readonly unknown[]): boolean {
  const r = rows.filter((x): x is Row => !!x && typeof x === 'object').map(x => ({ ...x, retrieved_at: num(x.retrieved_at) }))
  const site = identityOf(lead, r as never)
  if (leadPerson(r, '', undefined, site)) return true
  // Confirming the website is the one review that can change the answer, and only for a site still unconfirmed: run the real buyer rule
  // on exactly what that confirmation produces (the same site, user-confirmed). A stale bio, an incomplete name or a past title stays
  // unqualified; a conflicting or already-confirmed site gains nothing from a review.
  return site?.state === 'unconfirmed' && !!site.site && !!leadPerson(r, '', undefined, { state: 'user_confirmed', site: site.site, text: site.text })
}

// Only the rows that can ever name a buyer (leadPerson accepts only the crawl's people; the site identity reads the crawl's domain, check and
// email rows and the user's website review), so a lead's search and provider history is never loaded.
const REACH = "((e.connector = 'sitecrawl' AND e.kind IN ('person', 'domain', 'domain_check', 'email')) OR (e.connector = 'user' AND e.kind = 'domain_review'))"
// The most rows one read returns. A read that reaches it fails closed: its review leads count as research (buyerUnreachableFrom).
export const REACH_ROW_CAP = 20_000
// ONE read for the review-list leads of the given scans (a fixed number of queries, whatever the lead count), tenant-scoped on both the row
// and the scan, bounded by its cap (+1, so a read over it is detectable).
export const buyerReachSql = (jobs: number, cap = REACH_ROW_CAP) => `SELECT e.lead_id, e.kind, e.value, e.label, e.source_url, e.connector, e.retrieved_at
  FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ?
  WHERE e.tenant_id = ? AND ${REACH} AND l.review_reason IS NOT NULL AND l.scan_job_id IN (${Array(jobs).fill('?').join(',')})
  ORDER BY e.insert_seq LIMIT ${Math.max(1, Math.floor(cap)) + 1}`
export type ReachRow = Row & { lead_id: string }
// The leads (of those given) a review can NOT give a buyer, from the rows buyerReachSql read.
export function buyerUnreachableFrom(leads: readonly { id: string; contact: string | null }[], rows: readonly ReachRow[], cap = REACH_ROW_CAP): Set<string> {
  if (rows.length > cap) return new Set(leads.map(l => l.id))   // over the cap: an incomplete read names no buyer (fail closed)
  const by = new Map<string, Row[]>()
  for (const r of rows) { const a = by.get(r.lead_id) ?? []; a.push(r); by.set(r.lead_id, a) }
  return new Set(leads.filter(l => !reviewCanNameBuyer(l, by.get(l.id) ?? [])).map(l => l.id))
}
// An older schema with no enrichment table has no stored rows: no review lead can name its buyer (fails closed to research, as on Home).
export function noTable(e: unknown): ReachRow[] {
  if (/no such table|does not exist/i.test(String((e as Error)?.message))) return []
  throw e
}
// On the Db layer (SQLite or Postgres): the review-list leads of these scans a review cannot give a buyer.
export async function buyerUnreachable(db: Db, tenantId: string, jobIds: readonly string[], leads: readonly { id: string; contact: string | null }[], cap = REACH_ROW_CAP): Promise<Set<string>> {
  const ids = [...new Set(jobIds)]
  if (!ids.length) return new Set()   // one read per call whatever the leads, so a list's query count never depends on its lead count
  return buyerUnreachableFrom(leads, await db.all<ReachRow>(buyerReachSql(ids.length, cap), [tenantId, tenantId, ...ids]).catch(e => noTable(e)), cap)
}
