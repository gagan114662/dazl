// Is this proof page ONE job posting for the lead's company? Pure: an address, the page as it was read, and nothing else.
// lib/discover/check.ts asks it only for a hiring lead whose quoted evidence is a posting's title line. A title is a few words that
// stand on many pages (a board's list of openings, another company's posting with a "similar jobs" column, a team page, a news item),
// so for such a lead the PAGE has to be the proof: one open posting, of this company, carrying that title.
// Nothing here names a company, a place, an industry or a job title; the hosts below are applicant-tracking systems and job boards.

// Text as words: lower case, accents dropped, everything that is not a letter or a digit is one space.
export const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export interface PostingAddress { board: 'greenhouse' | 'lever' | 'ashby' | 'other'; host: string; org: string | null; id: string }
const UUID = /^[0-9a-f-]{36}$/i
// The address of a single posting on a known board, with the organisation the address carries (null when it carries none) and the
// posting's own id. A board's list of openings, its search page and every other address give null.
export function postingAddress(u: URL): PostingAddress | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, ''), s = u.pathname.split('/').filter(Boolean)
  const under = (root: string): string | null => (host.endsWith(`.${root}`) ? host.slice(0, -root.length - 1).split('.')[0] : null)
  const other = (org: string | null, id: string | undefined): PostingAddress | null => (id ? { board: 'other', host, org, id } : null)
  if (/(^|\.)greenhouse\.io$/.test(host)) return s.length >= 3 && s[1] === 'jobs' && /^\d+$/.test(s[2]) ? { board: 'greenhouse', host, org: s[0], id: s[2] } : null
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(host)) return s.length >= 2 && UUID.test(s[1]) ? { board: 'lever', host, org: s[0], id: s[1] } : null
  if (host === 'jobs.ashbyhq.com') return s.length >= 2 && UUID.test(s[1]) ? { board: 'ashby', host, org: s[0], id: s[1] } : null
  if (host === 'apply.workable.com') return s.length >= 3 && s[1] === 'j' ? other(s[0], s[2]) : null
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') return s.length >= 2 && /^\d{6,}/.test(s[1]) ? other(s[0], s[1]) : null
  if (under('recruitee.com')) return s[0] === 'o' ? other(under('recruitee.com'), s[1]) : null
  if (under('teamtailor.com')) return s[0] === 'jobs' && /^\d+/.test(s[1] ?? '') ? other(under('teamtailor.com'), s[1]) : null
  if (under('bamboohr.com')) return (s[0] === 'careers' || s[0] === 'jobs') && /^\d+$/.test(s[1] ?? '') ? other(under('bamboohr.com'), s[1]) : null
  if (under('myworkdayjobs.com')) { const i = s.indexOf('job'); return i >= 0 && i < s.length - 1 ? other(under('myworkdayjobs.com'), s[s.length - 1]) : null }
  if (host === 'ycombinator.com') return s[0] === 'companies' && s[2] === 'jobs' ? other(s[1], s[3]) : null
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return s[0] === 'jobs' && s[1] === 'view' ? other(null, s[2]) : null
  return null
}

// The organisation in a board address is the lead's company when, letters and digits only, it is the company's name (a closing legal
// form left out), the first words of that name run together (four characters or more), or the first label of the company's own domain.
const LEGAL = new Set('inc,llc,ltd,limited,gmbh,corp,corporation,co,company,plc,ag,sa,bv,pty,srl,sas,oy,ab'.split(','))
export function orgIsCompany(org: string, company: string, domain: string | null): boolean {
  let raw = org; try { raw = decodeURIComponent(org) } catch { /* as written */ }
  const o = fold(raw).replace(/ /g, '')
  if (o.length < 2) return false
  const words = fold(company).split(' ').filter(Boolean)
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop()
  let run = ''
  for (let i = 0; i < words.length; i++) { run += words[i]; if (run === o && (o.length >= 4 || i === words.length - 1)) return true }
  const label = fold((domain ?? '').replace(/^www\./i, '').split('.')[0]).replace(/ /g, '')
  return label.length >= 2 && label === o
}

// The page's own structured data: every JobPosting record it carries (JSON-LD), with its title and who it says is hiring.
export interface PostingRecord { title: string; org: string; orgUrls: string[] }
export function jobPostings(html: string): PostingRecord[] {
  const out: PostingRecord[] = [], str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const x of v.slice(0, 200)) walk(x, depth + 1); return }
    const o = v as Record<string, unknown>, t = o['@type']
    if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
      const h = o.hiringOrganization, ho = (h && typeof h === 'object' && !Array.isArray(h) ? h : {}) as Record<string, unknown>
      out.push({ title: str(o.title) || str(o.name), org: typeof h === 'string' ? h : str(ho.name), orgUrls: [ho.url, ...(Array.isArray(ho.sameAs) ? ho.sameAs : [ho.sameAs])].map(str).filter(Boolean) })
      return
    }
    walk(o['@graph'], depth + 1)
  }
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1]), 0) } catch { /* not JSON: no record */ } }
  return out
}

const onDomain = (host: string, domain: string | null): boolean => {
  const h = host.toLowerCase().replace(/^www\./, ''), d = (domain ?? '').toLowerCase().replace(/^www\./, '')
  return !!d && !!h && (h === d || h.endsWith(`.${d}`))
}
const hostOf = (raw: string): string => { try { return new URL(raw).hostname } catch { return '' } }
const inner = (html: string, re: RegExp): string[] => [...html.matchAll(re)].map(m => m[1].replace(/<[^>]+>/g, ' ').trim()).filter(Boolean)
// One opening's path on a company's own site: a careers or jobs section followed by the opening's own segment.
const SECTION = /^(?:careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|roles?|opportunities|join-us|work-with-us)$/i
const LIST_SEGMENT = /^(?:all|index|search|page|p|\d{1,2}|departments?|teams?|locations?)$/i
const SEARCH_KEYS = ['q', 'query', 'keywords', 'keyword', 'search']

export interface PostingPageInput {
  url: URL                    // the address the page was read at (after redirects, when dazl read it)
  company: string
  domain: string | null       // the company's own site
  quote: string               // the title line the lead quotes
  html: string | null         // the page's markup when dazl fetched it
  text: string                // the page's text (the reader's when there is no markup)
  pageTitle: string | null    // the title the run's search or reader gave the page
  names: (text: string) => boolean   // does this text name the company (check.ts companyOnPage)
}
// True when any of these holds:
//  1. the address is a single posting on a known board, and the organisation in it is the company or the page's own title names the
//     company (a board address is often an abbreviation; a "similar jobs" column never sets the page's title);
//  2. the page's own structured data is a JobPosting, one title, whose hiring organisation is the company;
//  3. the page is on the company's own site, its title or main heading is the quoted title line, and its path marks one opening or it
//     has an Apply control.
// A search-results address is refused outright. A board's list page fails 1 (no posting id), a list of several postings fails 2
// (several titles), and a list, team or news page on the company's site fails 3 (its heading is not the role).
export function postingPage(p: PostingPageInput): boolean {
  const s = p.url.pathname.split('/').filter(Boolean)
  if (s.some(x => /^search$/i.test(x)) || SEARCH_KEYS.some(k => p.url.searchParams.has(k))) return false
  const titles = [p.pageTitle ?? '', ...(p.html ? [...inner(p.html, /<title\b[^>]*>([\s\S]{0,300}?)<\/title>/gi), ...inner(p.html, /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']{0,300})["']/gi)] : [])].filter(Boolean)
  const at = postingAddress(p.url)
  if (at && ((at.org !== null && orgIsCompany(at.org, p.company, p.domain)) || titles.some(p.names))) return true
  const records = p.html ? jobPostings(p.html) : []
  if (records.length > 0 && new Set(records.map(r => fold(r.title))).size === 1 && records.every(r => (!!r.org && p.names(r.org)) || r.orgUrls.some(x => onDomain(hostOf(x), p.domain)))) return true
  if (!onDomain(p.url.hostname, p.domain)) return false
  const q = ` ${fold(p.quote)} `
  if (q.trim().length < 2) return false
  const heads = [...titles, ...(p.html ? inner(p.html, /<h1\b[^>]*>([\s\S]{0,400}?)<\/h1>/gi) : [])].map(h => ` ${fold(h)} `)
  // the heading holds the title line, or is its opening words (a heading "Role" over a line "Role - Place"), two words at least
  if (!heads.some(h => h.includes(q) || (h.trim().includes(' ') && q.startsWith(h)))) return false
  const section = s.findIndex(x => SECTION.test(x))
  const onePath = section >= 0 && section < s.length - 1 && !LIST_SEGMENT.test(s[s.length - 1])
  const apply = p.html ? /<(?:a|button)\b[^>]*>(?:\s|<[^>]+>)*apply\b/i.test(p.html) || /<input\b[^>]*\bvalue=["']apply\b/i.test(p.html) : /^\s*apply\b.{0,30}$/im.test(p.text)
  return onePath || apply
}
