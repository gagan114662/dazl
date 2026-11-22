// Refs #1122 (run aa19373443a2df2799185f33, prod 383ada0a): the company-first funding pass cited only multi-company roundups,
// all undated. The prompt already asks for the company's own newsroom; this enforces it on the funding pass's candidates.
// Structural rules only - no host allow- or deny-list, no company names. The ATS board parsers decide what a job board is.
import { atsPublisherRef } from '../sources/ats-posting.ts'

export type FundingSourceReason = 'job_posting' | 'multi_company_roundup' | 'own_site' | 'undated_own_site' | 'single_company_article' | 'undated_third_party'
export interface FundingSourceVerdict { verdict: 'accept' | 'read' | 'reject'; reason: FundingSourceReason }
export interface FundingSourceCand { company: string; website?: string | null; source_url: string; event_date?: string | null }

const parse = (raw: string): URL | null => { try { return new URL(raw) } catch { return null } }
const host = (raw: string | null | undefined): string => {
  if (!raw) return ''
  const u = parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  return u ? u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '') : ''
}
// the URL without query or fragment, host lower-cased, trailing slash dropped: one page, however it was cited
const pageKey = (raw: string): string => { const u = parse(raw); return u ? `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}` : raw }
const company = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function isJobPosting(raw: string, ownSite: boolean): boolean {
  const u = parse(raw)
  if (!u) return false
  const org = u.pathname.split('/').filter(Boolean)[0]
  // any page on a public job board the ATS parsers recognize (its board root names the board)
  if (org && atsPublisherRef(`https://${u.hostname}/${org}`)) return true
  return ownSite && /^\/(?:careers?|jobs?)(?:\/|$)/i.test(u.pathname)
}

export function fundingSourceVerdicts(cands: FundingSourceCand[]): FundingSourceVerdict[] {
  const companiesByPage = new Map<string, Set<string>>()
  for (const c of cands) { const k = pageKey(c.source_url); (companiesByPage.get(k) ?? companiesByPage.set(k, new Set()).get(k)!).add(company(c.company)) }
  return cands.map(c => {
    const src = host(c.source_url), own = host(c.website)
    const ownSite = !!src && !!own && (src === own || src.endsWith(`.${own}`))
    if (isJobPosting(c.source_url, ownSite)) return { verdict: 'reject', reason: 'job_posting' }
    if ((companiesByPage.get(pageKey(c.source_url))?.size ?? 0) >= 2) return { verdict: 'reject', reason: 'multi_company_roundup' }
    if (ownSite) return c.event_date ? { verdict: 'accept', reason: 'own_site' } : { verdict: 'reject', reason: 'undated_own_site' }
    return c.event_date ? { verdict: 'read', reason: 'single_company_article' } : { verdict: 'reject', reason: 'undated_third_party' }
  })
}
