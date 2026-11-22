// #1037: can a person's review still give a lead its buyer? The ONE answer every page that splits held leads into "review" and "research"
// counts by (Home heldState, the Campaigns list and history, the campaign page, a run's current split - all through lib/lead-state.ts
// reviewIsActionable), so no page calls a lead a review item that no review can make ready.
// Checking the source never names a buyer. Confirming the website makes a person that site lists with a page-linked LinkedIn current.
// So a review can name the buyer only when the buyer is already named (leadPerson on the lead's site identity) or the crawl stored such a
// person on a site still to be confirmed. Read from the lead's stored rows only; tenant-scoped; batched for list readers.
import type { Db } from '../db/client.ts'
import { leadPerson } from './lead-person.ts'
import { identityOf } from '../scan/opportunity.ts'
import { profileFromListedLabel } from './site-profile.ts'

type Row = { kind: string; value: string; label: string | null; source_url: string; connector: string; retrieved_at?: unknown }
const num = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : v

export function reviewCanNameBuyer(lead: { id: string; contact: string | null }, rows: readonly unknown[]): boolean {
  const r = rows.filter((x): x is Row => !!x && typeof x === 'object').map(x => ({ ...x, retrieved_at: num(x.retrieved_at) }))
  if (leadPerson(r, '', undefined, identityOf(lead, r as never))) return true
  return r.some(e => e.connector === 'sitecrawl' && e.kind === 'person' && !!profileFromListedLabel(e.label ?? null))
}

const KINDS = "('person', 'contact', 'domain', 'domain_check', 'domain_review', 'email')"
// ONE read for the review-list leads of the given scans (a fixed number of queries, whatever the lead count): their stored people and
// website-identity rows, tenant-scoped on both the row and the scan.
export const buyerReachSql = (jobs: number) => `SELECT e.lead_id, e.kind, e.value, e.label, e.source_url, e.connector, e.retrieved_at
  FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ?
  WHERE e.tenant_id = ? AND e.kind IN ${KINDS} AND l.review_reason IS NOT NULL AND l.scan_job_id IN (${Array(jobs).fill('?').join(',')})
  ORDER BY e.insert_seq`
export type ReachRow = Row & { lead_id: string }
// The leads (of those given) a review can NOT give a buyer, from the rows buyerReachSql read.
export function buyerUnreachableFrom(leads: readonly { id: string; contact: string | null }[], rows: readonly ReachRow[]): Set<string> {
  const by = new Map<string, Row[]>()
  for (const r of rows) { const a = by.get(r.lead_id) ?? []; a.push(r); by.set(r.lead_id, a) }
  return new Set(leads.filter(l => !reviewCanNameBuyer(l, by.get(l.id) ?? [])).map(l => l.id))
}
// On the Db layer (SQLite or Postgres): the review-list leads of these scans a review cannot give a buyer.
export async function buyerUnreachable(db: Db, tenantId: string, jobIds: readonly string[], leads: readonly { id: string; contact: string | null }[]): Promise<Set<string>> {
  const ids = [...new Set(jobIds)]
  if (!ids.length) return new Set()   // one read per call whatever the leads, so a list's query count never depends on its lead count
  return buyerUnreachableFrom(leads, await db.all<ReachRow>(buyerReachSql(ids.length), [tenantId, tenantId, ...ids]))
}
