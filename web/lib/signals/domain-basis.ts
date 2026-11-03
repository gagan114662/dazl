// Does the lead's company domain actually belong to the lead's company? The crawl records HOW it chose a domain (lead_enrichments kind 'domain',
// value "<site>|<basis>"). Only a domain the cited page itself is hosted on (evidence_own_domain), or one the user confirmed in a domain review,
// is established. A link, a link label or a name probe rest on the company NAME matching, which is not ownership: a job board found under such a
// domain's first label (e.g. a larger same-name company's) is a heuristic match, not the lead's own board.
import type Database from 'better-sqlite3'

export type DomainRelationship = 'established' | 'heuristic' | 'none'
export function domainRelationship(db: Database.Database, tenantId: string, leadId: string, domain: string | null | undefined): DomainRelationship {
  const d = (domain ?? '').trim().toLowerCase().replace(/^www\./, '')
  if (!d) return 'none'
  let rows: { connector: string; kind: string; value: string }[] = []
  try { rows = db.prepare("SELECT connector, kind, value FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND kind IN ('domain', 'domain_review')").all(leadId, tenantId) as typeof rows } catch { return 'heuristic' }
  const own = rows.some(r => r.connector === 'sitecrawl' && r.kind === 'domain' && r.value.toLowerCase().split('|')[0].replace(/^www\./, '') === d && r.value.toLowerCase().endsWith('|evidence_own_domain'))
  const reviewed = rows.some(r => r.connector === 'user' && r.kind === 'domain_review' && r.value.toLowerCase().replace(/^www\./, '') === d)
  return own || reviewed ? 'established' : 'heuristic'
}
export const HEURISTIC_NOTE = 'board found under a domain matched by company name; the company-to-board relationship is not established'

// "Confirmed" for CONTACT and SCORE purposes (wider than established, narrower than "a domain string is populated"): the domain is established,
// OR the crawl recorded that this domain's homepage named the company AND agreed with the scan's place or the lead's street address
// (a `domain_check` row written only after those checks passed). A populated company_domain with neither - a legacy name guess, a row
// from before the check existed - is a guess whose own contacts agree with it, which is self-consistency, not identity.
export const DOMAIN_CHECK_KIND = 'domain_check'
export function domainConfirmed(db: Database.Database, tenantId: string, leadId: string, domain: string | null | undefined): boolean {
  const d = (domain ?? '').trim().toLowerCase().replace(/^www\./, '')
  if (!d) return false
  if (domainRelationship(db, tenantId, leadId, d) === 'established') return true
  try {
    return (db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'sitecrawl' AND kind = ?").all(leadId, tenantId, DOMAIN_CHECK_KIND) as { value: string }[])
      .some(r => r.value.toLowerCase().split('|')[0].replace(/^www\./, '') === d)
  } catch { return false }
}
