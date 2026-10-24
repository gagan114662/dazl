// Free, read-only preview of what a saved-lead qualification would send. No model call, no spend.
// It reads the lead's own source page and, when the company site is confirmed, its home page,
// through the same guarded fetch the rest of the app uses.
import type Database from 'better-sqlite3'
import { fetchPageDetailed, isFail, type FetchFail, type Page } from './fetch-page.ts'
import { preparePrompt, estimateCost, DEFAULT_LIMITS, type QualifyInput, type EvidenceScope } from './lead-qualify.ts'
import { icpTextFor } from './score.ts'
import { parseIcp, fallbackIcp } from './icp.ts'

export type PageFetcher = (url: string) => Promise<Page | FetchFail>
export interface PreviewPage { url: string; role: 'posting' | 'company_home'; status: 'fetched' | 'failed'; chars: number; fail?: string }
export interface QualifyPreview {
  lead_id: string; company: string; seller_offer_present: boolean
  pages: PreviewPage[]
  cost: ReturnType<typeof estimateCost> | null; scope: EvidenceScope | null
  ready: boolean; notes: string[]
}

export async function qualifyPreview(db: Database.Database, userId: string, leadId: string, sellerText: string, fetchPage: PageFetcher = fetchPageDetailed, model: string | null = null): Promise<QualifyPreview | null> {
  const lead = db.prepare(`SELECT l.id, l.company, l.signal, l.source_url, l.company_domain, j.icp, j.query
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`).get(leadId, userId) as
    { id: string; company: string; signal: string; source_url: string; company_domain: string | null; icp: string | null; query: string | null } | undefined
  if (!lead) return null
  const notes: string[] = []
  const targets: { url: string; role: PreviewPage['role'] }[] = []
  if (/^https:\/\//.test(lead.source_url)) targets.push({ url: lead.source_url, role: 'posting' })
  if (lead.company_domain && /^[a-z0-9.-]+$/i.test(lead.company_domain)) targets.push({ url: `https://${lead.company_domain}/`, role: 'company_home' })
  else notes.push('No confirmed company site on this lead, so only the posting page can be used as evidence.')
  const got = await Promise.all(targets.map(async t => ({ t, r: await fetchPage(t.url).catch(() => ({ fail: 'error' }) as FetchFail) })))
  const pages: PreviewPage[] = got.map(({ t, r }) => isFail(r) ? { url: t.url, role: t.role, status: 'failed', chars: 0, fail: r.fail } : { url: t.url, role: t.role, status: 'fetched', chars: r.text.length })
  const ok = got.flatMap(({ t, r }) => isFail(r) || !r ? [] : [{ url: t.url, text: r.text }])
  const sellerOk = sellerText.trim().length > 0
  if (!sellerOk) notes.push('No seller profile saved, so there is nothing to judge fit against.')
  if (ok.length === 0) notes.push('No evidence page could be read.')
  const icp = lead.icp ? parseIcp(lead.icp) : null
  const input: QualifyInput = { seller_offer: sellerText, seller_icp: icpTextFor(icp ?? fallbackIcp(lead.query ?? ''), lead.query ?? ''), company: lead.company, signal: lead.signal, pages: ok }
  const prep = ok.length ? preparePrompt(input, DEFAULT_LIMITS) : null
  const cost = prep ? estimateCost(prep.prompt, model, DEFAULT_LIMITS) : null
  if (cost && !cost.priced) notes.push('The model that would run is not resolved or has no verified price here, so no dollar estimate is given.')
  return { lead_id: lead.id, company: lead.company, seller_offer_present: sellerOk, pages, cost, ready: sellerOk && ok.length > 0, notes, scope: prep?.scope ?? null }
}
