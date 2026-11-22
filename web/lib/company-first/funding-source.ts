// Refs #1122 (run aa19373443a2df2799185f33, prod 383ada0a): the company-first funding pass cited only multi-company roundups,
// all undated. The prompt already asks for the company's own newsroom; this enforces it on the funding pass's candidates.
// Structural rules only - no host allow- or deny-list, no company names. The ATS board parsers decide what a job board is.
import { atsPublisherRef } from '../sources/ats-posting.ts'

export type FundingSourceReason = 'job_posting' | 'multi_company_roundup' | 'own_site' | 'undated_own_site' | 'single_company_article' | 'undated_third_party'
export interface FundingSourceVerdict { verdict: 'accept' | 'read' | 'reject'; reason: FundingSourceReason }
export interface FundingSourceCand { company: string; website?: string | null; source_url: string; event_date?: string | null; page?: { title?: string | null; text?: string | null } | null }

const parse = (raw: string): URL | null => { try { return new URL(raw) } catch { return null } }
const host = (raw: string | null | undefined): string => {
  if (!raw) return ''
  const u = parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  return u ? u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '') : ''
}
// the URL without query or fragment, host lower-cased, trailing slash dropped: one page, however it was cited
const pageKey = (raw: string): string => { const u = parse(raw); return u ? `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}` : raw }
const company = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Any page shaped as a job page, with or without a website hint (Qodo #1530 c): a public job board the ATS parsers recognize, a careers/jobs
// host label, or a careers/jobs/positions/openings path segment anywhere in the path.
function isJobPosting(raw: string): boolean {
  const u = parse(raw)
  if (!u) return false
  const org = u.pathname.split('/').filter(Boolean)[0]
  if (org && atsPublisherRef(`https://${u.hostname}/${org}`)) return true
  if (/^(?:careers?|jobs?)\./i.test(u.hostname)) return true
  return u.pathname.split('/').some(s => /^(?:careers?|jobs?|job-openings?|open-positions?|positions?|openings?|vacanc(?:y|ies)|join-us|work-with-us)$/i.test(s))
}

// The page itself is a roundup (Qodo #1530 b), however many candidates cite it in this pass: its address or title names a list, tracker or
// periodic report, or its text states rounds for two or more different subjects. Structure only - no host list.
const LIST_WORDS = /\b(?:round-?ups?|trackers?|weekly|this[\s-]+week|digest|newsletter|report|top[\s-]+\d+|\d+[\s-]+(?:startups|companies)|funding[\s-]+rounds|deals?[\s-]+of[\s-]+the)\b/i
const ROUND_SUBJECT = /(?:^|[.!?]\s+)([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:has\s+)?(?:raised|raises|closed|closes|secured|secures|announced|announces|lands|landed)\b[^.]{0,80}?(?:\b(?:[Ss]eed|[Ss]eries\s+[A-Ea-e]|[Rr]ound|[Ff]unding)\b|\$\s?\d)/g
export function roundupPage(url: string, title: string | null | undefined, text: string | null | undefined): boolean {
  let path = ''
  try { path = decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, ' ') } catch { /* unreadable */ }
  if (LIST_WORDS.test(path) || LIST_WORDS.test(title ?? '')) return true
  const subjects = new Set([...(text ?? '').matchAll(ROUND_SUBJECT)].map(m => m[1].toLowerCase()))
  return subjects.size >= 2
}

export function fundingSourceVerdicts(cands: FundingSourceCand[]): FundingSourceVerdict[] {
  const companiesByPage = new Map<string, Set<string>>()
  for (const c of cands) { const k = pageKey(c.source_url); (companiesByPage.get(k) ?? companiesByPage.set(k, new Set()).get(k)!).add(company(c.company)) }
  return cands.map(c => {
    const src = host(c.source_url), own = host(c.website)
    const ownSite = !!src && !!own && (src === own || src.endsWith(`.${own}`))
    if (isJobPosting(c.source_url)) return { verdict: 'reject', reason: 'job_posting' }
    if ((companiesByPage.get(pageKey(c.source_url))?.size ?? 0) >= 2) return { verdict: 'reject', reason: 'multi_company_roundup' }
    if (!ownSite && roundupPage(c.source_url, c.page?.title, c.page?.text)) return { verdict: 'reject', reason: 'multi_company_roundup' }
    // Qodo #1530 a: an undated candidate is not discarded here - the reader may still date it from its own page, and the window rule
    // holds whatever stays undated. Only the reason records that it came in undated.
    if (ownSite) return c.event_date ? { verdict: 'accept', reason: 'own_site' } : { verdict: 'read', reason: 'undated_own_site' }
    return c.event_date ? { verdict: 'read', reason: 'single_company_article' } : { verdict: 'read', reason: 'undated_third_party' }
  })
}
