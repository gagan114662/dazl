import type Database from 'better-sqlite3'
import { crawlJob, sitecrawlEnabled, type Get } from '../connectors/sitecrawl.ts'
import { companySearchEligible } from './find-contact-eligible.ts'

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
    `SELECT l.id, l.scan_job_id, l.company, l.source_url, l.human_confirmed_at, l.human_confirmed_from, l.source_kind FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE l.id = ? AND j.user_id = ?`,
  ).get(leadId, userId) as { id: string; scan_job_id: string; company: string; source_url: string; human_confirmed_at: number | null; human_confirmed_from: string | null; source_kind: string | null } | undefined
  if (!lead) return { status: 'not_found', contacts: 0 }
  if (lead.human_confirmed_at === null) return { status: 'not_confirmed', contacts: 0 }
  if (!companySearchEligible(lead)) return { status: 'not_company', contacts: 0 }
  if (!sitecrawlEnabled(deps.env)) return { status: 'disabled', contacts: 0 }
  const count = () => (db.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE lead_id = ? AND connector = 'sitecrawl' AND kind IN ('email','phone')").get(lead.id) as { n: number }).n
  const before = count()
  await crawlJob(db, userId, lead.scan_job_id, { ...deps, leads: [{ id: lead.id, company: lead.company, source_url: lead.source_url }] })
  return { status: 'done', contacts: Math.max(0, count() - before) }
}
