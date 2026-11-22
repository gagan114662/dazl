// The discovery lane's LinkedIn reads (#1122, #1571 Part C). When a workspace has connected dazl Connect, a lead whose person has no
// LinkedIn profile yet gets ONE read of its company's People page in the customer's own browser: dazl reads the company's homepage
// (a public page, the guarded fetch), takes the one LinkedIn company page it links, and queues that page. The result handler
// (buyers.ts onCompanyPeopleResult) attaches the profile of the person the lead already names, or names the buyer by the play's roles.
// A few per scan: each read is one of the workspace's 40 LinkedIn pages a day. Never fails the scan.
import type { Db } from '../db/client.ts'
import { fetchPublicHtml } from '../net/public-fetch.ts'
import { companyPeopleUrl, enqueueCompanyPeople, hasExtension } from './buyers.ts'

export const MAX_COMPANY_READS_PER_SCAN = 5
export type LaneLead = { id: string; domain: string | null; hasProfile: boolean }
type ReadHome = (url: string) => Promise<string | null>
const readHome: ReadHome = async url => { const r = await fetchPublicHtml(url); return 'html' in r ? r.html : null }

export async function enqueueLanePeople(db: Db, tenantId: string, jobId: string, leads: LaneLead[], read: ReadHome = readHome, now?: number): Promise<number> {
  const todo = leads.filter(l => l.domain && !l.hasProfile).slice(0, MAX_COMPANY_READS_PER_SCAN)
  if (!todo.length || !(await hasExtension(db, tenantId))) return 0
  let queued = 0
  for (const l of todo) {
    try {
      const html = await read(`https://${l.domain}/`)
      const url = html ? companyPeopleUrl(html) : null
      if (url && await enqueueCompanyPeople(db, tenantId, jobId, l.id, url, now)) queued++
    } catch { /* this lead keeps what the run found */ }
  }
  return queued
}
