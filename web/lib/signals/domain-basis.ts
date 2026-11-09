// Does the lead's company domain actually belong to the lead's company? The crawl records HOW it chose a domain (lead_enrichments kind 'domain',
// value "<site>|<basis>"). Only a domain the cited page itself is hosted on (evidence_own_domain), or one the user confirmed in a domain review,
// is established. A link, a link label or a name probe rest on the company NAME matching, which is not ownership: a job board found under such a
// domain's first label (e.g. a larger same-name company's) is a heuristic match, not the lead's own board.
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { domainReviewFor } from '../outreach/domain-review.ts'

export type DomainRelationship = 'established' | 'heuristic' | 'none'
export const HEURISTIC_NOTE = 'board found under a domain matched by company name; the company-to-board relationship is not established'
export const DOMAIN_CHECK_KIND = 'domain_check'

type EvRow = { connector: string; kind: string; value: string; label: string | null; source_url: string | null; retrieved_at: number | null }
type ReviewLead = { id: string; contact: string | null }
const norm = (d: string | null | undefined): string => (d ?? '').trim().toLowerCase().replace(/^www\./, '')
const site = (v: string): string => norm(v.toLowerCase().split('|')[0])
// The lead is read under the tenant; the evidence rows are this tenant's rows for the lead.
const LEAD_SQL = 'SELECT l.id, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?'
const ROWS_SQL = "SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND ((connector = 'sitecrawl' AND kind IN ('email', 'domain', 'domain_check')) OR (connector = 'user' AND kind = 'domain_review'))"
// insert_seq gives Postgres the order SQLite's rowid read returns, so pickCrawledEmail's tie-break (and the review binding) is the same on both engines.
const ROWS_IN_ORDER_SQL = `${ROWS_SQL} ORDER BY insert_seq`

// The domain a user review CURRENTLY confirms, or null. A review row counts only through the canonical binding in
// outreach/domain-review.ts (#915): the same lead (under this tenant), domain, basis, pages and address the user was shown. A review whose
// address, page, basis or domain set has since changed, or whose label is missing or malformed, establishes nothing; it is not widened by value.
function reviewedFrom(lead: ReviewLead | undefined, rows: EvRow[]): string | null {
  if (!lead || !rows.some(r => r.connector === 'user' && r.kind === 'domain_review')) return null
  const r = domainReviewFor(lead, rows)
  return r.state === 'confirmed' && r.domain ? norm(r.domain) : null
}
// One rule for both engines. Established: the cited page is hosted on the domain (evidence_own_domain) or a current user review confirms it.
// Confirmed (CONTACT and SCORE purposes; wider than established, narrower than "a domain string is populated"): established, OR the crawl
// recorded that this domain's homepage named the company AND agreed with the scan's place or the lead's street address (a `domain_check`
// row written only after those checks passed). A populated company_domain with neither - a legacy name guess, a row from before the check
// existed - is a guess whose own contacts agree with it, which is self-consistency, not identity.
function verdictFrom(lead: ReviewLead | undefined, rows: EvRow[], d: string): { rel: DomainRelationship; confirmed: boolean } {
  const own = rows.some(r => r.connector === 'sitecrawl' && r.kind === 'domain' && site(r.value) === d && r.value.toLowerCase().endsWith('|evidence_own_domain'))
  const rel: DomainRelationship = own || reviewedFrom(lead, rows) === d ? 'established' : 'heuristic'
  return { rel, confirmed: rel === 'established' || rows.some(r => r.connector === 'sitecrawl' && r.kind === DOMAIN_CHECK_KIND && site(r.value) === d) }
}

function readSync(db: Database.Database, tenantId: string, leadId: string): { lead: ReviewLead | undefined; rows: EvRow[] } | null {
  let rows: EvRow[]
  try { rows = db.prepare(ROWS_SQL).all(leadId, tenantId) as EvRow[] } catch { return null }
  let lead: ReviewLead | undefined
  try { lead = db.prepare(LEAD_SQL).get(leadId, tenantId) as ReviewLead | undefined } catch { lead = undefined }
  return { lead, rows }
}
async function readDb(db: Db, tenantId: string, leadId: string): Promise<{ lead: ReviewLead | undefined; rows: EvRow[] } | null> {
  let rows: EvRow[]
  try { rows = await db.all<EvRow>(ROWS_IN_ORDER_SQL, [leadId, tenantId]) } catch { return null }
  let lead: ReviewLead | undefined
  try { lead = await db.get<ReviewLead>(LEAD_SQL, [leadId, tenantId]) } catch { lead = undefined }
  return { lead, rows }
}

export function domainRelationship(db: Database.Database, tenantId: string, leadId: string, domain: string | null | undefined): DomainRelationship {
  const d = norm(domain)
  if (!d) return 'none'
  const ev = readSync(db, tenantId, leadId)
  return ev ? verdictFrom(ev.lead, ev.rows, d).rel : 'heuristic'
}
export function domainConfirmed(db: Database.Database, tenantId: string, leadId: string, domain: string | null | undefined): boolean {
  const d = norm(domain)
  if (!d) return false
  const ev = readSync(db, tenantId, leadId)
  return ev ? verdictFrom(ev.lead, ev.rows, d).confirmed : false
}
export function currentReviewedDomain(db: Database.Database, tenantId: string, leadId: string): string | null {
  const ev = readSync(db, tenantId, leadId)
  return ev ? reviewedFrom(ev.lead, ev.rows) : null
}
// domainConfirmed on the Db layer (SQLite or Postgres): the same rule and the same rows, for routes ported to Db (#354).
export async function domainConfirmedDb(db: Db, tenantId: string, leadId: string, domain: string | null | undefined): Promise<boolean> {
  const d = norm(domain)
  if (!d) return false
  const ev = await readDb(db, tenantId, leadId)
  return ev ? verdictFrom(ev.lead, ev.rows, d).confirmed : false
}
