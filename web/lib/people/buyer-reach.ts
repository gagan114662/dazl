// #1037: can a person's review still give a lead its buyer? The ONE answer every page that splits held leads into "review" and "research"
// counts by (Home heldState, the Campaigns list and history, the campaign page, a run's current split - all through lib/lead-state.ts
// reviewIsActionable), so no page calls a lead a review item that no review can make ready.
// Checking the source never names a buyer. Confirming the website makes a person that site lists with a page-linked LinkedIn current.
// So a review can name the buyer only when the buyer is already named (leadPerson on the lead's site identity) or the crawl stored such a
// person on a site still to be confirmed. Read from the lead's stored rows only; tenant-scoped; batched for list readers.
import type Database from 'better-sqlite3'
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
const sql = (n: number) => `SELECT lead_id, kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments
  WHERE tenant_id = ? AND kind IN ${KINDS} AND lead_id IN (${Array(n).fill('?').join(',')}) ORDER BY insert_seq`
const CHUNK = 400
function unreachable(leads: readonly { id: string; contact: string | null }[], rows: (Row & { lead_id: string })[]): Set<string> {
  const by = new Map<string, Row[]>()
  for (const r of rows) { const a = by.get(r.lead_id) ?? []; a.push(r); by.set(r.lead_id, a) }
  return new Set(leads.filter(l => !reviewCanNameBuyer(l, by.get(l.id) ?? [])).map(l => l.id))
}
// The leads (of those given) a review can NOT give a buyer. Missing table (an older schema): every lead, fail closed to research.
export function buyerUnreachableSync(db: Database.Database, tenantId: string, leads: readonly { id: string; contact: string | null }[]): Set<string> {
  const rows: (Row & { lead_id: string })[] = []
  try { for (let i = 0; i < leads.length; i += CHUNK) { const ids = leads.slice(i, i + CHUNK).map(l => l.id); rows.push(...db.prepare(sql(ids.length)).all(tenantId, ...ids) as (Row & { lead_id: string })[]) } }
  catch (e) { if (!/no such table/i.test(String((e as Error)?.message))) throw e }
  return unreachable(leads, rows)
}
export async function buyerUnreachable(db: Db, tenantId: string, leads: readonly { id: string; contact: string | null }[]): Promise<Set<string>> {
  const rows: (Row & { lead_id: string })[] = []
  for (let i = 0; i < leads.length; i += CHUNK) { const ids = leads.slice(i, i + CHUNK).map(l => l.id); rows.push(...await db.all<Row & { lead_id: string }>(sql(ids.length), [tenantId, ...ids])) }
  return unreachable(leads, rows)
}
