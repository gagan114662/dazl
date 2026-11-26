// Reads a lead's proof page ourselves and labels the lead. It never hides one (launch brief, Step 3): a page we could not
// read, or that does not name the company, lowers what we say about the lead and is shown to the user as such.
import type { DiscoveredLead, SeenPage } from './agent.ts'
import { dateMentions } from '../scan/date-in-text.ts'
import { isHiringTrigger } from '../scan/scoreboard.ts'
import { discoveryHiringDateProven } from '../scan/timing-proof.ts'

// confirmed: the page text (as Claude's reader returned it, or as dazl fetched it) names the company.
// listed: the page came back in the run's search results with the company in its title, but nobody could read its text.
// company_not_on_page: the text was read and does not name the company. unseen: the run never saw this URL and dazl could not read it.
// 'gone': the proof address answers 'not found', or the page it serves says the job or page no longer exists (staging 2026-11-23: a 404
// and a 'Job not found' page were shown as verified proof). A page that is gone proves nothing, whatever a search result still says.
export type ProofState = 'confirmed' | 'listed' | 'company_not_on_page' | 'unseen' | 'gone'
// date_source distinguishes a date taken from an opened source from the search index's day for the page itself.
// date_on_page records whether the exact calendar day was found in the proof page's text.
export interface CheckedLead extends DiscoveredLead { proof: ProofState; proof_read_by: 'reader' | 'dazl' | null; quote_on_page: boolean; signal_seen: boolean; claim_lacks: string[]; date_on_page: boolean; page_age: string | null; date: string | null; date_source: 'page' | 'index' | null; signal_by?: 'claude' }
// A lead is shown when its proof is confirmed or listed (launch brief, Step 3). Everything else about it only changes its label.
// ...and something the run actually saw speaks of the SIGNAL, not just of the company (signal_seen, set by the checks below):
//   - a page whose text was read: the words the run quoted as evidence are in that text, and in one place where they stand the page's
//     own statements that hold them (quoteStatements) state the signal line, every distinguishing word of it (statesSignal);
//   - a page nobody could read: the search result's own title names the company and states that line.
// claim_lacks: the words of the signal line that proof does not carry (empty when it carries them all); with the quote in several
// places, those of the place that lacks fewest.
// A date is never support. The day the search index gives a page, and a day-of-month number found somewhere on a page, only label
// the lead (date, date_source, date_on_page): a recently indexed directory profile, or a company page that happens to print the
// year and a number, says nothing about the signal (#1571, review of #1575). Such a lead goes to the user's review.
export const isShown = (l: CheckedLead): boolean => (l.proof === 'confirmed' || l.proof === 'listed') && l.signal_seen

// A page stores punctuation and accented letters as entities ("it&#x27;s", "caf&eacute;"); a person reads the character, and so does a quote
// taken from the page. Decoded after the tags are gone and in one pass, so escaped markup stays text. An accented letter becomes its plain
// letter, which is what fold() makes of it anyway; an entity this does not know is left as written.
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' }
const entities = (s: string) => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, e: string) => {
  if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? /^([a-z])(?:acute|grave|circ|uml|tilde|cedil|ring|caron|slash)$/i.exec(e)?.[1] ?? whole
  const cp = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1))
  return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : ' '
})
// Blocks stay apart (one line each), so a statement never runs on into the next heading, list item or paragraph. A line break in the
// HTML source is not structure (a paragraph is often wrapped mid-sentence), so source whitespace is flattened before the blocks are cut.
const text = (html: string) => entities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/\s+/g, ' ')
  .replace(/<\/?(?:p|div|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|section|article|header|footer|nav|aside|main|blockquote|figure|figcaption|title|br|hr)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .replace(/[^\S\n]+/g, ' ').replace(/ ?\n[ \n]*/g, '\n')
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// The company is on the page when its name appears, or when the words of its name (ignoring very short ones) all do.
export function companyOnPage(company: string, page: string): boolean {
  const c = fold(company), p = ` ${fold(page)} `
  if (!c) return false
  if (p.includes(` ${c} `)) return true
  const words = c.split(' ').filter(w => w.length > 2)
  return words.length > 0 && words.every(w => p.includes(` ${w} `))
}
// The words of a text that carry meaning for matching: four letters or more, or any token with a digit ("12m", "2026"), each reduced
// to a plain stem so "opening", "opens" and "opened" are the word "open", and "raise" is the word "raised" and "raising" are (the
// plain form of such a verb ends in an e its other forms drop: without this "to hire 40 engineers" did not state "Hiring 40 engineers").
const stem = (w: string) => { for (const suf of ['ing', 'ed', 'es', 's']) if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length); return w.endsWith('e') ? w.slice(0, -1) : w }
// An amount is one word however it is written: "$12 million", "12-million" and "$12M" are all "12m". A funding page prints one form in
// its headline and the other in its text, and the signal line uses either (#1575: "has raised $12 million" did not state "Raised $12M").
const amounts = (s: string) => s.replace(/(\d)[\s-]?(million|mln|mn|billion|bn|thousand)\b/gi, (_, d: string, u: string) => d + (/^b/i.test(u) ? 'b' : /^t/i.test(u) ? 'k' : 'm'))
// Words that only join other words say nothing a proof could carry or lack; with every word of the line required, they must not count.
const JOINING = new Set('with,from,that,this,these,those,than,then,them,they,their,there,here,into,onto,upon,over,under,about,after,before,between,through,during,within,without,across,against,among,around,behind,beside,beyond,toward,towards,until,while,when,where,which,what,whose,whom,will,would,could,should,shall,might,must,have,having,been,being,were,does,also,plus,both,each,either,neither,some,such,very,just,only,itself,themselves,because,although,though,however,along,alongside'.split(','))
const content = (s: string): string[] => fold(amounts(s)).split(' ').filter(w => (w.length >= 4 && !JOINING.has(w)) || /\d/.test(w)).map(stem)
// Two stems are the same word when equal, or when they share their first five letters ("expansion" / "expand").
const same = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5))
// The signal's own words (the company's name left out), how many of them a text carries, and which it lacks (as stems).
export function signalWordsIn(signal: string, company: string, textToSearch: string): { want: number; found: number; missing: string[] } {
  const name = new Set(content(company))
  const want = [...new Set(content(signal).filter(w => !name.has(w)))]
  const have = content(textToSearch)
  const missing = want.filter(w => !have.some(h => same(w, h)))
  return { want: want.length, found: want.length - missing.length, missing }
}
// A text states the signal when it carries EVERY distinguishing word of the signal line. No proportion, and no part of the line is set
// aside: each of those let a claim through without its own words (both reviews of #1575). Three in four let detail outvote the claim
// ("Opening a second clinic at 14 Main Street, open Monday to Friday" on address-and-hours text); judging only a first statement let a
// place stand in for it ("... clinic Toronto Ontario, opening a second clinic." on the same text). A line that says more than its proof
// does goes to the user's review, with the words its proof lacks (claim_lacks).
export function statesSignal(signal: string, company: string, textToSearch: string): boolean {
  const { want, missing } = signalWordsIn(signal, company, textToSearch)
  return want > 0 && missing.length === 0
}
// When the quoted evidence IS on a read page and its statements do not carry every word of the signal line, the words cannot settle
// it either way. Measured on staging, 2026-11-23 (commit 96111ddd, two real searches, 15 leads): the every-word rule alone showed 1
// of 15, although 12 had their quote on a page naming the company (the companies' own sites and job postings). The engine's signal
// line runs 6 to 23 distinguishing words (an address, "posted 7 days ago") and no one statement holds them all. A count of shared
// words cannot tell those from a sentence of address and opening hours quoted for an "opening" claim (both share 4 or more). So that
// one question is put to Claude (lib/discover/entail.ts): does this quoted text state the claim's event? Without an asker (tests,
// the replay script) the every-word rule decides alone, as before.
export type AskSignal = (signal: string, company: string, statements: string[]) => Promise<boolean>
// The page's own statements: a line or block, cut again where a full stop, question mark, exclamation mark or semicolon ends one.
const statements = (page: string): string[] => page.split(/\n+|(?<=[.!?…;])\s+/).map(s => s.trim()).filter(Boolean)
// The quoted evidence must be contiguous after formatting normalization, even if its edges clip a word. An explicit ellipsis can omit
// words inside a single statement, but each quoted fragment must still occur there in order.
// This, not the run's excerpt, is what a claim is judged against: an excerpt stops where the run cut it (300 characters at most), and
// words in an excerpt that the page does not print are not evidence. A word in the next statement is not this statement's word.
// Each place is its own evidence and is judged alone. The same words often stand in several places (a heading, a menu, two unrelated
// sentences); pooling them let one place's words finish another's claim (review of #1575 at 0db467b5).
export function quoteStatements(quote: string | null, page: string): string[] {
  const q = fold(quote ?? '')
  if (q.length < 12) return []
  const all = statements(page)
  const parts: string[] = [], starts: number[] = [], statementIndices: number[] = []
  let offset = 0
  all.forEach((statement, i) => {
    const part = fold(statement)
    if (!part) return
    parts.push(part)
    starts.push(offset)
    statementIndices.push(i)
    offset += part.length + 1
  })
  const normalized = parts.join(' ')
  const places = new Set<string>()
  let first = 0, last = 0
  for (let at = normalized.indexOf(q); at >= 0; at = normalized.indexOf(q, at + 1)) {
    while (starts[first + 1] <= at) first++
    const end = at + q.length - 1
    while (starts[last + 1] <= end) last++
    places.add(all.slice(statementIndices[first], statementIndices[last] + 1).join(' '))
  }
  if (places.size === 0) {
    const fragments = (quote ?? '').split(/…|\.{3}/).map(fold).filter(Boolean)
    if (fragments.length > 1) for (const statement of all) {
      const line = ` ${fold(statement)} `
      let next = 0
      if (fragments.every(fragment => {
        const start = line.indexOf(` ${fragment} `, next)
        if (start < 0) return false
        next = start + fragment.length + 1
        return true
      })) places.add(statement)
    }
  }
  return [...places]
}
export const quoteOnPage = (quote: string | null, page: string): boolean => quoteStatements(quote, page).length > 0

// Match a complete date mention and exclude labels for edits and copyright notices.
const EDIT_DATE_PREFIX = /(?:\b(?:updated|modified|copyright)\b|©)(?:\s+(?:on|at|as of))?[\s:(|·,–—-]*(?:(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?[\s,]+)?(?:\d{1,2}:\d{2}(?:\s*(?:a\.?m\.?|p\.?m\.?))?(?:\s+[a-z]{2,5})?[\s,]+)?[\s:(|·,–—-]*$/i

export function dayOnPage(day: string | null, page: string): boolean {
  if (!day) return false
  return dateMentions(page).some(mention => mention.day === day &&
    !EDIT_DATE_PREFIX.test(page.slice(Math.max(0, mention.index - 40), mention.index)))
}

// The search index's age for a page ("69 days ago", "3 hours ago", "October 14, 2026", an ISO day) as a calendar day, or null.
export function pageAgeDay(age: string | null | undefined, now: Date = new Date()): string | null {
  const a = (age ?? '').trim()
  if (!a) return null
  const rel = /^(\d{1,5})\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(a)
  if (rel) {
    const n = Number(rel[1]), unit = rel[2].toLowerCase()
    const days = unit === 'minute' || unit === 'hour' ? 0 : unit === 'day' ? n : unit === 'week' ? n * 7 : unit === 'month' ? n * 30 : n * 365
    return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  }
  const t = Date.parse(a)
  return Number.isNaN(t) || t > now.getTime() + 86_400_000 ? null : new Date(t).toISOString().slice(0, 10)
}
export const INDEX_DATE_MAX_AGE_DAYS = 365
const indexDate = (page_age: string | null, now: Date): Pick<CheckedLead, 'date' | 'date_source'> => {
  const d = pageAgeDay(page_age, now)
  // #1571: a search index dates a page by when it first saw it. For a long-lived page (a company's own site) that day can be years before
  // what the page says now, so an index day older than a year is not shown as the signal's date; the lead reads as missing a date instead.
  const stale = !!d && now.getTime() - Date.parse(`${d}T00:00:00Z`) > INDEX_DATE_MAX_AGE_DAYS * 86_400_000
  return d && !stale ? { date: d, date_source: 'index' } : { date: null, date_source: null }
}

// Public http(s) pages only: no credentials, no local or private hosts.
function publicUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null
    const h = u.hostname.toLowerCase()
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) return null
    return u
  } catch { return null }
}

// Two URLs are the same page when host (without www.), path (without a trailing slash) and query match.
const pageKey = (raw: string): string => { try { const u = new URL(raw); return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}` } catch { return raw } }

// A page that says its own content is gone: a short page whose words are a not-found or closed-posting notice. Long pages are never judged
// this way (a live page may mention that another role was filled).
// Since a gone page's lead is dropped, not only labelled (lib/scan/runner.ts, review of PR #1687), the words must be a notice and not
// ordinary text: a bare "404" is also a street number ("opening at 404 Yonge Street"), "not found" alone is also a sentence, and "the
// CFO position has been filled" is the very news a new-leader search looks for. Those no longer count; "this position has been
// filled" still does (TAKEN_DOWN below), as does an address that answers 404 or 410 (checkLead).
// Second review: a bare "no longer available" or "does not exist" is also ordinary text ("the old Queen St clinic is no longer
// available; the new one opens 3 Dec"), so those count only when the sentence is about a page, job or listing. A notice this
// misses leaves its lead in review, which is the safe side.
const GONE = /\b(?:job|page|position|posting|listing|role|opening|vacancy)\s+(?:was\s+|is\s+|has\s+been\s+)?(?:not\s+found|no\s+longer\s+(?:available|open|active|accepting\s+applications)|removed|expired)\b|\b(?:error\s+404|http\s+404|404\s+(?:error|not\s+found|page\s+not\s+found)|page\s+not\s+found)\b|^(?:404\s*[-:|]?\s*)?not\s+found\.?$|\b(?:page|job|posting|listing|position|role|vacancy)\b[^.!?]{0,60}\b(?:(?:doesn't|does\s+not)\s+exist|no\s+longer\s+exists)\b/i
// A notice that THIS listing is gone, specific enough to trust on a long page too when it stands near the top (a job board keeps its
// header, footer and "similar jobs" around the notice; Quest, staging 2026-11-23: a listing "recently taken down" was shown as proof).
const TAKEN_DOWN = /\bthis\s+(?:job\s+)?(?:job|listing|posting|position|role|opening|vacancy|page)\s+(?:was|is|has\s+been)\s+(?:recently\s+)?(?:taken\s+down|removed|closed|filled|expired|deleted|unpublished)\b|\bthis\s+(?:job\s+)?(?:job|listing|posting|position|role)\s+(?:is\s+)?no\s+longer\s+(?:available|open|active|listed|accepting\s+applications)\b|\b(?:job|listing|posting)\s+not\s+found\b|\b(?:was|been)\s+recently\s+taken\s+down\b/i
export const pageIsGone = (body: string): boolean => { const t = body.replace(/\s+/g, ' ').trim(); return (t.length < 1500 && GONE.test(t)) || TAKEN_DOWN.test(t.slice(0, 2500)) }
// "Posted 4d ago", "Posted: 3 days ago", "Published 2 weeks ago": the day that works out to, when the page prints exactly one such age.
// Several different ages on one page (a list of postings) give no date.
export function relativeDay(body: string, now: Date, hiringOnly = false): string | null {
  const days = new Set<number>()
  for (const m of body.matchAll(/\b(?:posted|published|listed|updated)\s*:?\s*(?:on\s+)?(\d{1,3})\+?\s*(hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?)\s+ago\b/gi)) {
    if (hiringOnly && !/^posted\b/i.test(m[0])) continue
    const n = Number(m[1]), u = m[2].toLowerCase()
    days.add(u.startsWith('h') ? 0 : u.startsWith('d') ? n : u.startsWith('w') ? n * 7 : n * 30)
  }
  if (days.size !== 1) return null
  const [d] = [...days]
  return d > 365 ? null : new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10)
}
function judge(lead: DiscoveredLead, body: string, by: 'reader' | 'dazl', page_age: string | null, now: Date): CheckedLead {
  if (pageIsGone(body)) return { ...lead, ...indexDate(page_age, now), proof: 'gone', proof_read_by: by, page_age, quote_on_page: false, signal_seen: false, claim_lacks: [], date_on_page: false }
  // A read page supports the signal when the quoted evidence is on it and, in ONE place where it stands, the page's own statements
  // that hold it state the signal line. Places are never added together.
  const named = companyOnPage(lead.company, body), said = quoteStatements(lead.evidence_quote, body)
  const nearest = said.map(s => signalWordsIn(lead.signal, lead.company, s)).sort((a, b) => a.missing.length - b.missing.length)[0] ?? signalWordsIn(lead.signal, lead.company, '')
  const hiring = isHiringTrigger(lead.signal)
  const posted = hiring ? [...new Set(dateMentions(body).filter(mention =>
    /\bposted(?:\s+on)?[\s:–—-]*$/i.test(body.slice(Math.max(0, mention.index - 32), mention.index)),
  ).map(mention => mention.day))] : []
  const statedDay = hiring ? (posted.length === 1 ? posted[0] : null) : dayOnPage(lead.signal_date, body) ? lead.signal_date : null
  const day = statedDay ?? (posted.length > 1 ? null : relativeDay(body, now, hiring))
  return { ...lead, ...(day ? { date: day, date_source: 'page' as const } : indexDate(page_age, now)), proof: named ? 'confirmed' : 'company_not_on_page', proof_read_by: by, page_age,
    quote_on_page: said.length > 0, signal_seen: named && said.some(s => statesSignal(lead.signal, lead.company, s)), claim_lacks: nearest.missing, date_on_page: statedDay !== null }
}

// The quote is on the page, the page names the company, and the words alone did not settle it: Claude says whether the quoted text states
// the claim. signal_by records who decided. An asker that fails leaves the lead as the words left it (not shown; the user's review).
async function settle(c: CheckedLead, body: string, ask?: AskSignal): Promise<CheckedLead> {
  if (!ask || c.proof !== 'confirmed' || !c.quote_on_page || c.signal_seen) return c
  const said = quoteStatements(c.evidence_quote, body).slice(0, 4).map(s => s.slice(0, 600))
  try { return (await ask(c.signal, c.company, said)) ? { ...c, signal_seen: true, signal_by: 'claude' } : { ...c, signal_by: 'claude' } } catch { return c }
}
// The day a page states in its own structured data: a job posting's datePosted, else an article's datePublished (JSON-LD or a meta
// tag). Job boards print "Posted 4d ago" or nothing in the visible text and carry the real day here. Not dateModified (a template edit
// moves it), not a day in the future, not one more than a year old.
export function embeddedDay(html: string, now: Date, hiringOnly = false): string | null {
  const m = /"datePosted"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(html) ?? (hiringOnly ? null : /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(html)
    ?? /<meta[^>]+(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]+content=["'](\d{4}-\d{2}-\d{2})/i.exec(html))
  if (!m) return null
  const t = Date.parse(`${m[1]}T00:00:00Z`)
  return Number.isNaN(t) || t > now.getTime() + 86_400_000 || now.getTime() - t > INDEX_DATE_MAX_AGE_DAYS * 86_400_000 ? null : m[1]
}
// A posting on Greenhouse, Lever or Ashby prints no date in its page. The board publishes the same posting as a record that carries
// the day it was first published; that record is the proof page's own data, read from the board itself (no third party). Staging
// 2026-11-23: every hiring lead on these boards came back undated.
const validDay = (t: number, now: Date): string | null => Number.isNaN(t) || t > now.getTime() + 86_400_000 || now.getTime() - t > INDEX_DATE_MAX_AGE_DAYS * 86_400_000 ? null : new Date(t).toISOString().slice(0, 10)
export function postingRecord(u: URL): { url: string; day: (j: unknown) => unknown } | null {
  const h = u.hostname.toLowerCase(), seg = u.pathname.split('/').filter(Boolean)
  const obj = (j: unknown) => (j && typeof j === 'object' ? j as Record<string, unknown> : {})
  if (/(^|\.)greenhouse\.io$/.test(h) && seg.length >= 3 && seg[1] === 'jobs' && /^\d+$/.test(seg[2]))
    return { url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(seg[0])}/jobs/${seg[2]}`, day: j => obj(j).first_published }
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(h) && seg.length >= 2 && /^[0-9a-f-]{36}$/i.test(seg[1]))
    return { url: `${h === 'jobs.eu.lever.co' ? 'https://api.eu.lever.co/v0/postings/' : 'https://api.lever.co/v0/postings/'}${encodeURIComponent(seg[0])}/${seg[1]}`, day: j => obj(j).createdAt }
  if (h === 'jobs.ashbyhq.com' && seg.length >= 2 && /^[0-9a-f-]{36}$/i.test(seg[1]))
    return { url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(seg[0])}`, day: j => { const jobs = obj(j).jobs; const hit = Array.isArray(jobs) ? jobs.find(x => obj(x).id === seg[1] || String(obj(x).jobUrl ?? '').includes(seg[1])) : null; return obj(hit).publishedAt } }
  return null
}
async function postingDay(u: URL, fetchImpl: typeof fetch, timeoutMs: number, now: Date): Promise<string | null> {
  const rec = postingRecord(u)
  if (!rec) return null
  try {
    const r = await fetchImpl(rec.url, { redirect: 'follow', signal: AbortSignal.timeout(Math.min(timeoutMs, 8_000)), headers: { accept: 'application/json' } })
    if (!r.ok) return null
    const v = rec.day(await r.json())
    return typeof v === 'number' ? validDay(v, now) : typeof v === 'string' ? validDay(Date.parse(v), now) : null
  } catch { return null }
}
// The named person's own LinkedIn profile, when the proof page links it (Quest, staging rerun 2026-11-23: a job posting linked the
// poster's profile and the lead had none). A link counts when it is a person's profile (/in/<name>) and its link text, or the profile
// address itself, carries the person's first and last name. Two different matching profiles give none: the page does not say which.
const personParts = (n: string): string[] => n.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\b(?:dr|mr|mrs|ms|prof)\.?\s/g, ' ').match(/[a-z]{2,}/g) ?? []
export function profileOnPage(html: string, person: string): string | null {
  const who = personParts(person)
  if (who.length < 2) return null
  const first = who[0], last = who[who.length - 1], found = new Map<string, string>()
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["'](https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/in\/([^"'/?#\s]{2,})\/?(?:[?#][^"']*)?)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    let slug = m[2]; try { slug = decodeURIComponent(slug) } catch { /* as written */ }
    const label = personParts(m[3].replace(/<[^>]+>/g, ' ')), inSlug = personParts(slug.replace(/[-_.]/g, ' '))
    const names = (parts: string[]) => parts.includes(first) && parts.includes(last)
    if (names(label) || names(inSlug)) found.set(slug.toLowerCase(), `https://www.linkedin.com/in/${m[2]}`)
  }
  return found.size === 1 ? [...found.values()][0] : null
}
// What the proof page itself adds to a confirmed lead: a date (the job board's own record of the posting, else the page's structured
// data) when the run and the page text gave none, and the named person's LinkedIn profile when the page links it. `html` is dazl's raw
// read when it has one; otherwise the page is fetched once, and only when something is still missing.
async function fromPage(c: CheckedLead, html: string | null, u: URL | null, fetchImpl: typeof fetch, timeoutMs: number, now: Date): Promise<CheckedLead> {
  if (c.proof !== 'confirmed') return c
  const needDate = c.date_source !== 'page', needProfile = !!c.person && !c.linkedin_url
  if (!needDate && !needProfile) return c
  let out = c
  if (needDate && u) { const posted = await postingDay(u, fetchImpl, timeoutMs, now); if (posted) out = { ...out, date: posted, date_source: 'page' } }
  const stillDate = needDate && out.date_source !== 'page'
  if (!stillDate && !needProfile) return out
  let raw = html
  if (raw === null && u) {
    try { const r = await fetchImpl(u, { redirect: 'follow', signal: AbortSignal.timeout(Math.min(timeoutMs, 8_000)), headers: { 'user-agent': 'Mozilla/5.0 (compatible; dazl/1.0; +https://dazl.ai)', accept: 'text/html,application/xhtml+xml' } }); if (r.ok) raw = (await r.text()).slice(0, 1_500_000) } catch { /* nothing more from the page */ }
  }
  if (!raw) return out
  if (stillDate) { const day = embeddedDay(raw, now, isHiringTrigger(c.signal)); if (day) out = { ...out, date: day, date_source: 'page' } }
  if (needProfile) { const profile = profileOnPage(raw, c.person!); if (profile) out = { ...out, linkedin_url: profile } }
  return out
}
export async function checkLead(lead: DiscoveredLead, seen: SeenPage[] = [], fetchImpl: typeof fetch = fetch, timeoutMs = 12_000, now: Date = new Date(), ask?: AskSignal): Promise<CheckedLead> {
  const checked = await readLead(lead, seen, fetchImpl, timeoutMs, now, ask)
  if (discoveryHiringDateProven(checked, INDEX_DATE_MAX_AGE_DAYS, now)) return checked
  return { ...checked, date: null, date_source: null, date_on_page: false }
}

async function readLead(lead: DiscoveredLead, seen: SeenPage[], fetchImpl: typeof fetch, timeoutMs: number, now: Date, ask?: AskSignal): Promise<CheckedLead> {
  const key = pageKey(lead.evidence_url)
  const hit = seen.find(p => pageKey(p.url) === key) ?? null
  // 1. the text Claude's reader returned for this very page
  if (hit?.text) return fromPage(await settle(judge(lead, hit.text, 'reader', hit.page_age, now), hit.text, ask), null, publicUrl(lead.evidence_url), fetchImpl, timeoutMs, now)
  // 2. dazl's own read of the page
  const u = publicUrl(lead.evidence_url)
  let denied = false
  if (u) {
    try {
      const r = await fetchImpl(u, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (compatible; dazl/1.0; +https://dazl.ai)', accept: 'text/html,application/xhtml+xml' } })
      if (r.ok) { const html = (await r.text()).slice(0, 1_500_000), body = text(html); return fromPage(await settle(judge(lead, body, 'dazl', hit?.page_age ?? null, now), body, ask), html, u, fetchImpl, timeoutMs, now) }
      denied = r.status === 401 || r.status === 403
      // dazl asked and the address is gone: a search result's title does not bring it back
      if (r.status === 404 || r.status === 410) return { ...lead, ...indexDate(hit?.page_age ?? null, now), proof: 'gone', proof_read_by: 'dazl', page_age: hit?.page_age ?? null, quote_on_page: false, signal_seen: false, claim_lacks: [], date_on_page: false }
    } catch { /* fall through to what the search results say */ }
  }
  const alternate = lead.alternate_evidence
  if (denied && alternate && publicUrl(alternate.url) && pageKey(alternate.url) !== key) {
    const read = seen.find(p => p.text && pageKey(p.url) === pageKey(alternate.url))
    if (read?.text) {
      const candidate = { ...lead, evidence_url: alternate.url, evidence_quote: alternate.quote, signal_date: alternate.date }
      const checked = await settle(judge(candidate, read.text, 'reader', read.page_age, now), read.text, ask)
      if (isShown(checked)) return checked
    }
  }
  // 3. nobody could read it: a search result of this run with the company in its title is a real page about that company
  const base = { ...lead, ...indexDate(hit?.page_age ?? null, now), proof_read_by: null, quote_on_page: false, date_on_page: false, page_age: hit?.page_age ?? null }
  // An unread search result supports the signal when its own title states the signal line.
  const listed = !!hit && companyOnPage(lead.company, hit.title ?? ''), title = listed ? hit!.title ?? '' : ''
  return { ...base, proof: listed ? 'listed' : 'unseen', signal_seen: listed && statesSignal(lead.signal, lead.company, title), claim_lacks: signalWordsIn(lead.signal, lead.company, title).missing }
}

export async function checkLeads(leads: DiscoveredLead[], seen: SeenPage[] = [], fetchImpl: typeof fetch = fetch, concurrency = 4, ask?: AskSignal): Promise<CheckedLead[]> {
  const out: CheckedLead[] = new Array(leads.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, leads.length) }, async () => {
    for (let i = next++; i < leads.length; i = next++) out[i] = await checkLead(leads[i], seen, fetchImpl, undefined, undefined, ask)
  }))
  return out
}
