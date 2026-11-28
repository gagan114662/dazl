import type Database from 'better-sqlite3'
import { crawlJob, sitecrawlEnabled, type Get } from '../connectors/sitecrawl.ts'
import { companySearchEligible, companySearchEligibleSettled } from './find-contact-eligible.ts'
import { identityOf } from './opportunity.ts'
import { domainMatchesCompany, siteSettled } from '../people/work-email-eligible.ts'

// On request from the user, run the same free public contact-page crawl that scans run for
// machine-verified leads, for ONE lead the user has already confirmed. Confirmed leads were
// otherwise never searched ("Contact search only runs for machine-verified leads"), so a lead
// the user confirmed whose company publishes a role mailbox could not reach a draft.
// It reuses every existing guard (https only, robots.txt, 2 s per host, own-domain role
// mailboxes only, homepage must name the company, source URL stored with each contact). No AI,
// no paid call, no email. It does not change the lead's confirmation or any verdict.
export type FindContactResult = { status: 'not_found' | 'not_confirmed' | 'not_company' | 'disabled' | 'done'; contacts: number }

export { NON_COMPANY_REVIEW, companySearchEligible } from './find-contact-eligible.ts'

export async function findContactForConfirmedLead(
  db: Database.Database, userId: string, leadId: string,
  deps: { get?: Get; gapMs?: number; env?: Record<string, string | undefined>; signal?: AbortSignal } = {},
): Promise<FindContactResult> {
  const lead = db.prepare(
    `SELECT l.id, l.scan_job_id, l.company, l.contact, l.source_url, l.human_confirmed_at, l.human_confirmed_from, l.source_kind FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE l.id = ? AND j.user_id = ?`,
  ).get(leadId, userId) as { id: string; scan_job_id: string; company: string; contact: string | null; source_url: string; human_confirmed_at: number | null; human_confirmed_from: string | null; source_kind: string | null } | undefined
  if (!lead) return { status: 'not_found', contacts: 0 }
  if (lead.human_confirmed_at === null) return { status: 'not_confirmed', contacts: 0 }
  let crawlUrl = lead.source_url
  if (!companySearchEligible(lead)) {
    // #1177: a customer-mention lead is still searched when its own site is settled on the stored rows (see
    // find-contact-eligible.ts); the crawl below then runs on that site, under every existing guard.
    const rows = db.prepare('SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ?').all(lead.id) as { connector: string; kind: string; value: string; label: string | null; source_url: string | null }[]
    const identity = identityOf({ id: lead.id, contact: lead.contact }, rows)
    const settledSite = siteSettled(identity) ? identity.site : null
    if (!companySearchEligibleSettled(lead, settledSite !== null && domainMatchesCompany(settledSite, lead.company))) return { status: 'not_company', contacts: 0 }
    // The crawl starts from the settled site itself, not the citing page: starting from source_url let it
    // wander to a different same-name site and store that site's contacts as this company's (Qodo, #1177).
    crawlUrl = `https://${settledSite}`
  }
  if (!sitecrawlEnabled(deps.env)) return { status: 'disabled', contacts: 0 }
  const count = () => (db.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE lead_id = ? AND connector = 'sitecrawl' AND kind IN ('email','phone')").get(lead.id) as { n: number }).n
  const before = count()
  await crawlJob(db, userId, lead.scan_job_id, { ...deps, leads: [{ id: lead.id, company: lead.company, source_url: crawlUrl }] })
  return { status: 'done', contacts: Math.max(0, count() - before) }
}
