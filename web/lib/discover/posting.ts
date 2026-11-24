// Is this proof page ONE job posting for the lead's company? Pure: an address, the page as it was read, and nothing else.
// lib/discover/check.ts asks it only for a hiring lead whose quoted evidence is a posting's title line. A title is a few words that
// stand on many pages (a board's list of openings, another company's posting with a "similar jobs" column, a team page, a news item),
// so for such a lead the PAGE has to be the proof: one open posting, of this company, carrying that title.
// Nothing here names a company, a place, an industry or a job title; the hosts below are applicant-tracking systems and job boards.

// Text as words: lower case, accents dropped, everything that is not a letter or a digit is one space.
export const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export interface PostingAddress { board: 'greenhouse' | 'lever' | 'ashby' | 'aggregator' | 'other'; host: string; org: string | null; id: string }
const UUID = /^[0-9a-f-]{36}$/i
// A page of a known board: null when the address is not on one; otherwise the single posting it is (with the organisation the address
// carries, null when it carries none, and the posting's own id), or posting null for the board's list, search and every other page.
function boardPage(u: URL): { posting: PostingAddress | null } | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, ''), s = u.pathname.split('/').filter(Boolean)
  const under = (root: string): string | null => (host.endsWith(`.${root}`) ? host.slice(0, -root.length - 1).split('.')[0] : null)
  const other = (ok: boolean, org: string | null, id: string | undefined): { posting: PostingAddress | null } => ({ posting: ok && id ? { board: 'other', host, org, id } : null })
  if (/(^|\.)greenhouse\.io$/.test(host)) return { posting: s.length >= 3 && s[1] === 'jobs' && /^\d+$/.test(s[2]) ? { board: 'greenhouse', host, org: s[0], id: s[2] } : null }
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(host)) return { posting: s.length >= 2 && UUID.test(s[1]) ? { board: 'lever', host, org: s[0], id: s[1] } : null }
  if (host === 'jobs.ashbyhq.com') return { posting: s.length >= 2 && UUID.test(s[1]) ? { board: 'ashby', host, org: s[0], id: s[1] } : null }
  if (host === 'apply.workable.com') return other(s.length >= 3 && s[1] === 'j', s[0], s[2])
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') return other(s.length >= 2 && /^\d{6,}/.test(s[1]), s[0], s[1])
  if (under('recruitee.com')) return other(s[0] === 'o', under('recruitee.com'), s[1])
  if (under('teamtailor.com')) return other(s[0] === 'jobs' && /^\d+/.test(s[1] ?? ''), under('teamtailor.com'), s[1])
  if (under('bamboohr.com')) return other((s[0] === 'careers' || s[0] === 'jobs') && /^\d+$/.test(s[1] ?? ''), under('bamboohr.com'), s[1])
  if (under('myworkdayjobs.com')) { const i = s.indexOf('job'); return other(i >= 0 && i < s.length - 1, under('myworkdayjobs.com'), s[s.length - 1]) }
  // A job site that prints MANY employers' postings, each on a page of its own with no organisation in the address and (measured on
  // staging, 2026-11-24) no JobPosting data: /job/<slug>/<number>. Its search and company pages are board pages that are no posting.
  if (/^builtin[a-z]*\.com$/.test(host)) return { posting: s.length === 3 && s[0] === 'job' && /^\d+$/.test(s[2]) ? { board: 'aggregator', host, org: null, id: s[2] } : null }
  // sites that are more than a job board: only their jobs pages are board pages
  if (host === 'ycombinator.com') return s[0] === 'jobs' || (s[0] === 'companies' && s[2] === 'jobs') ? other(s[0] === 'companies', s[1] ?? null, s[3]) : null
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return s[0] === 'jobs' ? other(s[1] === 'view', null, s[2]) : null
  return null
}
export const postingAddress = (u: URL): PostingAddress | null => boardPage(u)?.posting ?? null

// A company's name as words, a closing legal form left out ("Northwind Dental Inc." is "northwind dental").
const LEGAL = new Set('inc,llc,ltd,limited,gmbh,corp,corporation,co,company,plc,ag,sa,bv,pty,srl,sas,oy,ab,llp,lp'.split(','))
export const legalForm = (word: string): boolean => LEGAL.has(word)
export function companyName(company: string): string {
  const words = fold(company).split(' ').filter(Boolean)
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop()
  return words.join(' ')
}
// The organisation in a board address against the lead's company, letters and digits only. 'whole': it is the company's name, or the
// first label of the company's own domain. 'first': it is only the first words of the name run together (four characters or more);
// many companies share a first word, so the caller must also find the full name on the page. null: neither.
export function orgMatch(org: string, company: string, domain: string | null): 'whole' | 'first' | null {
  let raw = org; try { raw = decodeURIComponent(org) } catch { /* as written */ }
  const o = fold(raw).replace(/ /g, '')
  if (o.length < 2) return null
  const words = companyName(company).split(' ').filter(Boolean)
  const label = fold((domain ?? '').replace(/^www\./i, '').split('.')[0]).replace(/ /g, '')
  if (words.join('') === o || (label.length >= 2 && label === o)) return 'whole'
  let run = ''
  for (const w of words.slice(0, -1)) { run += w; if (run === o && o.length >= 4) return 'first' }
  return null
}

// The page's own structured data: every JobPosting record it carries (JSON-LD), with its title and who it says is hiring.
export interface PostingRecord { title: string; org: string; orgUrls: string[]; validThrough: string }
export function jobPostings(html: string): PostingRecord[] {
  const out: PostingRecord[] = [], str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const x of v.slice(0, 200)) walk(x, depth + 1); return }
    const o = v as Record<string, unknown>, t = o['@type']
    if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
      const h = o.hiringOrganization, ho = (h && typeof h === 'object' && !Array.isArray(h) ? h : {}) as Record<string, unknown>
      out.push({ title: str(o.title) || str(o.name), org: typeof h === 'string' ? h : str(ho.name), orgUrls: [ho.url, ...(Array.isArray(ho.sameAs) ? ho.sameAs : [ho.sameAs])].map(str).filter(Boolean), validThrough: str(o.validThrough) })
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
const count = (s: string, re: RegExp): number => [...s.matchAll(re)].length
// One opening's path on a company's own site: a careers or jobs section followed by the opening's own segment.
const SECTION = /^(?:careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|roles?|opportunities|join-us|work-with-us)$/i
const LIST_SEGMENT = /^(?:all|index|search|page|p|\d{1,2}|departments?|teams?|locations?)$/i
const SEARCH_KEYS = ['q', 'query', 'keywords', 'keyword', 'search']
const onePath = (u: URL): boolean => { const s = u.pathname.split('/').filter(Boolean), i = s.findIndex(x => SECTION.test(x)); return i >= 0 && i < s.length - 1 && !LIST_SEGMENT.test(s[s.length - 1]) }
// How many OTHER openings the page links: single postings on a board, or one-opening paths on the company's own site.
function otherOpenings(html: string, at: URL, domain: string | null): number {
  const here = at.pathname.replace(/\/+$/, ''), found = new Set<string>()
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], at), path = u.pathname.replace(/\/+$/, '')
      if (postingAddress(u) || (onDomain(u.hostname, domain) && onePath(u) && path !== here)) found.add(`${u.hostname}${path}`)
    } catch { /* not an address */ }
  }
  return found.size
}

// The top of a posting on a many-employer site: from the start of the page to a little past its main heading, the text of the
// headings there and of the elements marked as the company or employer (a class, an itemprop or a link to the company's page).
// A "similar jobs" column further down the page is not in it.
function topOfPosting(html: string): string[] {
  const end = html.search(/<\/h1>/i)
  if (end < 0) return []
  const top = html.slice(0, end + 1500)
  return [...inner(top, /<h[1-3]\b[^>]*>([\s\S]{0,400}?)<\/h[1-3]>/gi), ...inner(top, /<[a-z][a-z0-9]*\b[^>]*\b(?:class|itemprop|data-id|href)=["'][^"']*(?:company|employer|hiringOrganization)[^"']*["'][^>]*>((?:\s|<[^>]+>)*[^<]{1,200})/gi)]
}

// Could this page be a job posting at all: is it a page of a known board, a page on the company's own site, or a page that carries
// JobPosting data? Only there does the posting rule govern a title-line lead. Anywhere else (a news site, a directory) such a lead
// keeps the statement rules of check.ts, exactly as before.
export function postingKind(url: URL, html: string | null, domain: string | null): boolean {
  return boardPage(url) !== null || onDomain(url.hostname, domain) || (!!html && jobPostings(html).length > 0)
}

export interface PostingPageInput {
  url: URL                    // the address the page was served from (after redirects, when dazl read it)
  company: string
  domain: string | null       // the company's own site
  quote: string               // the title line the lead quotes
  html: string | null         // the page's markup when dazl fetched it
  text: string                // the page's text (the reader's when there is no markup)
  pageTitle: string | null    // the title the run's search or reader gave the page
  now: Date
}
// True when any of these holds:
//  1. the address is a single posting on a known board, and the organisation in it is the company, or the page's own title carries the
//     company's full name (a board address is often an abbreviation; a "similar jobs" column never sets the page's title). An
//     organisation that is only the FIRST words of the name also needs the full name somewhere on the page.
//  2. the page's own structured data is a JobPosting, one title, whose hiring organisation is the company;
//  3. the page is on the company's own site, its title or main heading is the quoted title line, and it is one opening's page: an
//     Apply control, or a careers path ending in the opening with few other openings linked. A one-word title needs the Apply control
//     (a department's list is headed by one word too); more than two Apply controls are a list.
// Refused outright: a search-results address, and a page whose JobPosting data says the posting has expired (validThrough). A
// board's list page fails 1 (no posting id), records for several openings fail 2, and a list, team or news page on the company's
// site fails 3 (its heading is not the role).
export function postingPage(p: PostingPageInput): boolean {
  const s = p.url.pathname.split('/').filter(Boolean)
  if (s.some(x => /^search$/i.test(x)) || SEARCH_KEYS.some(k => p.url.searchParams.has(k))) return false
  const records = p.html ? jobPostings(p.html) : []
  // validThrough names the last day the posting is open: a day later it has expired
  if (records.some(r => { const t = Date.parse(r.validThrough); return !Number.isNaN(t) && t + 86_400_000 < p.now.getTime() })) return false
  const name = companyName(p.company), named = (t: string): boolean => !!name && ` ${fold(t)} `.includes(` ${name} `)
  const titles = [p.pageTitle ?? '', ...(p.html ? [...inner(p.html, /<title\b[^>]*>([\s\S]{0,300}?)<\/title>/gi), ...inner(p.html, /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']{0,300})["']/gi)] : [])].filter(Boolean)
  const q = ` ${fold(p.quote)} `
  const heads = [...titles, ...(p.html ? inner(p.html, /<h1\b[^>]*>([\s\S]{0,400}?)<\/h1>/gi) : [])].map(h => ` ${fold(h)} `)
  // the heading holds the title line, or is its opening words (a heading "Role" over a line "Role - Place"), two words at least
  const headed = q.trim().length >= 2 && heads.some(h => h.includes(q) || (h.trim().includes(' ') && q.startsWith(h)))
  const at = postingAddress(p.url)
  if (at?.board === 'aggregator') {
    // a site that prints many employers' postings: the page's title or main heading must be the quoted title, and the company's full
    // name must stand in the page's title or at the top of the posting (topOfPosting), never merely somewhere in the body
    if (headed && (titles.some(named) || (!!p.html && topOfPosting(p.html).some(named)))) return true
  } else if (at) {
    const org = at.org === null ? null : orgMatch(at.org, p.company, p.domain)
    if (org === 'whole' || titles.some(named) || (org === 'first' && named(p.text))) return true
  }
  if (records.length > 0 && new Set(records.map(r => fold(r.title))).size === 1 && records.every(r => named(r.org) || r.orgUrls.some(x => onDomain(hostOf(x), p.domain)))) return true
  if (!onDomain(p.url.hostname, p.domain) || !headed) return false
  const applies = p.html ? count(p.html, /<(?:a|button)\b[^>]*>(?:\s|<[^>]+>)*apply\b/gi) + count(p.html, /<input\b[^>]*\bvalue=["']apply\b/gi) : count(p.text, /^\s*apply\b.{0,30}$/gim)
  if (applies > 2) return false
  const few = !p.html || otherOpenings(p.html, p.url, p.domain) < 3
  return q.trim().includes(' ') ? applies > 0 || (onePath(p.url) && few) : applies > 0 && few
}
