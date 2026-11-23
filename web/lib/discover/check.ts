// Reads a lead's proof page ourselves and labels the lead. It never hides one (launch brief, Step 3): a page we could not
// read, or that does not name the company, lowers what we say about the lead and is shown to the user as such.
import type { DiscoveredLead, SeenPage } from './agent.ts'

// confirmed: the page text (as Claude's reader returned it, or as dazl fetched it) names the company.
// listed: the page came back in the run's search results with the company in its title, but nobody could read its text.
// company_not_on_page: the text was read and does not name the company. unseen: the run never saw this URL and dazl could not read it.
export type ProofState = 'confirmed' | 'listed' | 'company_not_on_page' | 'unseen'
// date: the day shown for the signal. date_source says where it came from: 'page' = Claude read it on the proof page (date_on_page says whether
// dazl also found it in the page text); 'index' = the proof page prints no date, so this is the day the search index dates the page itself.
export interface CheckedLead extends DiscoveredLead { proof: ProofState; proof_read_by: 'reader' | 'dazl' | null; quote_on_page: boolean; signal_seen: boolean; date_on_page: boolean; page_age: string | null; date: string | null; date_source: 'page' | 'index' | null }
// A lead is shown when its proof is confirmed or listed (launch brief, Step 3). Everything else about it only changes its label.
// ...and something the run actually saw speaks of the SIGNAL, not just of the company (signal_seen, set by the checks below):
//   - a page whose text was read: the words the run quoted as evidence are in that text, and those words state the signal's claim (statesSignal);
//   - a page nobody could read: the search result's own title names the company and states that claim.
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
const text = (html: string) => entities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
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
const content = (s: string): string[] => fold(amounts(s)).split(' ').filter(w => w.length >= 4 || /\d/.test(w)).map(stem)
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
// A text states the signal's CLAIM, not merely its topic, when it carries the claim's distinguishing words: every one of them for a
// short claim (three words or fewer), three in four for a longer one. Sharing some words is not enough: "clinic opening hours" shares
// two of the three words of "opening a second clinic" and says nothing about a second clinic (second review of #1575).
//
// The claim is the signal line's first statement. What the run writes after it (an address, the other investors, its own comment on what
// the event means) is detail, and counting detail as claim failed both ways on real data (#1575 replay): a quote is one sentence, so 13
// of the 16 leads stored on staging failed with their proof in hand; and detail that matches routine text carried a false claim past
// three in four ("Opening a second clinic, Monday to Friday" was stated by "clinic opening hours Monday to Friday"). A statement ends at
// a full stop, semicolon, colon, bracket, dash or comma; one too short to be a claim is extended with what follows until it has three
// distinguishing words, so a place or a name alone is never the claim. Limit: a long first statement with no punctuation between the
// event and its detail is still judged three in four.
export function leadStatement(signal: string, company: string): string {
  let lead = ''
  for (const part of signal.split(/(?<=[.;:!?])\s+|\s+[–—-]\s+|\s*\(|,\s+/)) {
    lead = lead ? `${lead} ${part}` : part
    if (signalWordsIn(lead, company, '').want >= 3) break
  }
  return lead
}
export function statesSignal(signal: string, company: string, textToSearch: string): boolean {
  const states = (claim: string) => { const { want, found } = signalWordsIn(claim, company, textToSearch); return want > 0 && found >= (want <= 3 ? want : Math.ceil(want * 0.75)) }
  return states(leadStatement(signal, company))
}
// The quoted evidence is on the page: the whole quote, or any six consecutive words of it (a quote is often trimmed or joined with an ellipsis).
export function quoteOnPage(quote: string | null, page: string): boolean {
  const q = fold(quote ?? ''), p = fold(page)
  if (q.length < 12) return false
  if (p.includes(q)) return true
  const w = q.split(' ')
  for (let i = 0; i + 6 <= w.length; i++) if (p.includes(w.slice(i, i + 6).join(' '))) return true
  return false
}
// A read page supports the signal when the quoted evidence is on it and that quote states the signal's claim.
const quoteSupports = (lead: DiscoveredLead, page: string): boolean => quoteOnPage(lead.evidence_quote, page) && statesSignal(lead.signal, lead.company, lead.evidence_quote ?? '')
// An unread search result supports the signal when its own title states the signal's claim.
const titleSupports = (lead: DiscoveredLead, title: string): boolean => statesSignal(lead.signal, lead.company, title)

// The day is on the page when its year is and either the ISO day or the day-of-month number is (pages print dates in many
// styles and languages, so this is a weak check on purpose: it labels, it does not decide).
export function dayOnPage(day: string | null, page: string): boolean {
  if (!day) return false
  const [y, , d] = day.split('-')
  return page.includes(day) || (page.includes(y) && new RegExp(`(^|\\D)0?${Number(d)}(\\D|$)`).test(page))
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
const dated = (lead: DiscoveredLead, page_age: string | null, now: Date): Pick<CheckedLead, 'date' | 'date_source'> => {
  if (lead.signal_date) return { date: lead.signal_date, date_source: 'page' }
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

function judge(lead: DiscoveredLead, body: string, by: 'reader' | 'dazl', page_age: string | null, now: Date): CheckedLead {
  const named = companyOnPage(lead.company, body)
  return { ...lead, ...dated(lead, page_age, now), proof: named ? 'confirmed' : 'company_not_on_page', proof_read_by: by, page_age,
    quote_on_page: quoteOnPage(lead.evidence_quote, body), signal_seen: named && quoteSupports(lead, body), date_on_page: dayOnPage(lead.signal_date, body) }
}

export async function checkLead(lead: DiscoveredLead, seen: SeenPage[] = [], fetchImpl: typeof fetch = fetch, timeoutMs = 12_000, now: Date = new Date()): Promise<CheckedLead> {
  const key = pageKey(lead.evidence_url)
  const hit = seen.find(p => pageKey(p.url) === key) ?? null
  // 1. the text Claude's reader returned for this very page
  if (hit?.text) return judge(lead, hit.text, 'reader', hit.page_age, now)
  // 2. dazl's own read of the page
  const u = publicUrl(lead.evidence_url)
  if (u) {
    try {
      const r = await fetchImpl(u, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (compatible; dazl/1.0; +https://dazl.ai)', accept: 'text/html,application/xhtml+xml' } })
      if (r.ok) return judge(lead, text((await r.text()).slice(0, 1_500_000)), 'dazl', hit?.page_age ?? null, now)
    } catch { /* fall through to what the search results say */ }
  }
  // 3. nobody could read it: a search result of this run with the company in its title is a real page about that company
  const base = { ...lead, ...dated(lead, hit?.page_age ?? null, now), proof_read_by: null, quote_on_page: false, date_on_page: false, page_age: hit?.page_age ?? null }
  const listed = !!hit && companyOnPage(lead.company, hit.title ?? '')
  return { ...base, proof: listed ? 'listed' : 'unseen', signal_seen: listed && titleSupports(lead, hit!.title ?? '') }
}

export async function checkLeads(leads: DiscoveredLead[], seen: SeenPage[] = [], fetchImpl: typeof fetch = fetch, concurrency = 4): Promise<CheckedLead[]> {
  const out: CheckedLead[] = new Array(leads.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, leads.length) }, async () => {
    for (let i = next++; i < leads.length; i = next++) out[i] = await checkLead(leads[i], seen, fetchImpl)
  }))
  return out
}
