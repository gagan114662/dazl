// #1122 step 3: the buyer at a company, from its LinkedIn People page as read in the user's own browser (the dazl LinkedIn Reader).
//   1. A scan's crawl of a company's CONFIRMED site that names no buyer, where the site's own homepage links exactly one LinkedIn company
//      page, queues one company_people read of that page (enqueueCompanyPeople). Only when the workspace has an extension token.
//   2. When the extension posts what it read, the person whose title meets this scan's buyer bar (chooseSiteBuyer: the ICP's own role,
//      then seniority; a tie between two people is no buyer) is stored on the lead: name, title, and their LinkedIn profile as the source.
//      The person is a candidate like any other: siteContactFromRows still applies the request's buyer bar before it is shown.
// No company, title or place is hard-coded: the page is the company's own link, the role is the scan's own ICP.
import type { Db, Tx, TxBody } from '../db/client.ts'
import { chooseSiteBuyer } from '../connectors/sitecrawl.ts'
import { addEnrichmentTx } from '../connectors/store.ts'
import { LINKEDIN_PEOPLE_LABEL } from '../scan/site-contact.ts'
import { enqueueTask } from './store.ts'
import { personOk, type ReadPerson } from './limits.ts'

// The ONE LinkedIn company page a homepage links to, as its People page URL; null when it links none or several (ambiguous).
export function companyPeopleUrl(homeHtml: string): string | null {
  const slugs = new Set<string>()
  for (const m of homeHtml.matchAll(/href\s*=\s*["']https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/company\/([A-Za-z0-9%_.-]{1,100})\/?(?:[?#][^"']*)?["']/gi)) slugs.add(decodeURIComponent(m[1]).toLowerCase())
  if (slugs.size !== 1) return null
  const slug = [...slugs][0]
  return /^[a-z0-9_.-]{1,100}$/.test(slug) ? `https://www.linkedin.com/company/${slug}/people/` : null
}

export async function hasExtension(db: Db, tenantId: string): Promise<boolean> {
  return !!(await db.get('SELECT 1 AS x FROM li_ext_tokens WHERE tenant_id = ?', [tenantId]))
}
const ref = (jobId: string, leadId: string) => `lead:${jobId}:${leadId}`
export async function enqueueCompanyPeople(db: Db, tenantId: string, jobId: string, leadId: string, peopleUrl: string, now?: number): Promise<string | null> {
  if (!(await hasExtension(db, tenantId))) return null
  return enqueueTask(db, tenantId, 'company_people', peopleUrl, ref(jobId, leadId), now)
}

// The buyer among the people read, by this scan's buyer roles; null when nobody meets the bar or the top is a tie.
export function chooseLinkedInBuyer(people: ReadPerson[], buyerRoles: string): ReadPerson | null {
  const found = people.map(p => ({ kind: 'person', value: `${p.name}, ${p.title}`, url: p.profile_url, label: LINKEDIN_PEOPLE_LABEL }))
  const b = chooseSiteBuyer(found as Parameters<typeof chooseSiteBuyer>[0], buyerRoles)
  return b ? people.find(p => p.profile_url === b.url) ?? null : null
}

export type BuyerOutcome = 'stored' | 'no_buyer' | 'already_named' | 'not_a_lead_task'
export async function onCompanyPeopleResult(db: Db, tenantId: string, taskId: string): Promise<BuyerOutcome> {
  return db.tx(function* (t: Tx): TxBody<BuyerOutcome> {
    const task = yield* t.get<{ kind: string; requested_by: string | null }>("SELECT kind, requested_by FROM li_tasks WHERE id = ? AND tenant_id = ? AND status = 'done'", [taskId, tenantId])
    const m = task?.kind === 'company_people' ? /^lead:([^:]{1,80}):([^:]{1,80})$/.exec(task.requested_by ?? '') : null
    if (!m) return 'not_a_lead_task'
    const [, jobId, leadId] = m
    const job = yield* t.get<{ icp: string | null }>('SELECT icp FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId])
    const lead = yield* t.get<{ id: string }>('SELECT id FROM leads WHERE id = ? AND scan_job_id = ?', [leadId, jobId])
    if (!job || !lead) return 'not_a_lead_task'
    let roles = ''
    try { const who = job.icp ? (JSON.parse(job.icp) as { who?: unknown }).who : null; if (Array.isArray(who)) roles = who.filter(x => typeof x === 'string').join('; ').slice(0, 600) } catch { roles = '' }
    if (!roles) return 'no_buyer'
    const res = yield* t.get<{ fetched_at: number; payload: string }>('SELECT fetched_at, payload FROM li_results WHERE task_id = ? AND tenant_id = ?', [taskId, tenantId])
    let people: ReadPerson[] = []
    try { people = ((JSON.parse(res?.payload ?? '{}') as { people?: unknown[] }).people ?? []).map(personOk).filter((p): p is ReadPerson => !!p) } catch { people = [] }
    const buyer = chooseLinkedInBuyer(people, roles)
    if (!buyer) return 'no_buyer'
    const named = yield* t.get<{ x: number }>("SELECT 1 AS x FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND connector = 'sitecrawl' AND kind = 'person' LIMIT 1", [tenantId, leadId])
    if (named) return 'already_named'
    const at = Number(res!.fetched_at)
    yield* addEnrichmentTx(t, tenantId, leadId, { connector: 'sitecrawl', kind: 'person', value: `${buyer.name}, ${buyer.title}`.slice(0, 254), label: LINKEDIN_PEOPLE_LABEL, confidence: null,
      source_url: buyer.profile_url, source_date: new Date(at * 1000).toISOString().slice(0, 10), retrieved_at: at })
    return 'stored'
  })
}
