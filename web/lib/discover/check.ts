// Reads a lead's proof page ourselves and labels the lead. It never hides one (launch brief, Step 3): a page we could not
// read, or that does not name the company, lowers what we say about the lead and is shown to the user as such.
import type { DiscoveredLead, SeenPage } from './agent.ts'

// confirmed: the page text (as Claude's reader returned it, or as dazl fetched it) names the company.
// listed: the page came back in the run's search results with the company in its title, but nobody could read its text.
// company_not_on_page: the text was read and does not name the company. unseen: the run never saw this URL and dazl could not read it.
export type ProofState = 'confirmed' | 'listed' | 'company_not_on_page' | 'unseen'
// date: the day shown for the signal. date_source says where it came from: 'page' = Claude read it on the proof page (date_on_page says whether
// dazl also found it in the page text); 'index' = the proof page prints no date, so this is the day the search index dates the page itself.
export interface CheckedLead extends DiscoveredLead { proof: ProofState; proof_read_by: 'reader' | 'dazl' | null; quote_on_page: boolean; date_on_page: boolean; page_age: string | null; date: string | null; date_source: 'page' | 'index' | null }
// A lead is shown when its proof is confirmed or listed (launch brief, Step 3). Everything else about it only changes its label.
// ...and the page shows something of the SIGNAL, not just the company: the quoted words or the signal's day are in the page text, or the
// search index dates the page inside the last year (a recent page about the company). A directory or profile page that only names
// the company (#1571: a review-site listing accepted as proof of an expansion) shows none of these and goes to the user's review.
export const signalSeen = (l: CheckedLead): boolean => l.quote_on_page || l.date_on_page || l.date_source === 'index'
export const isShown = (l: CheckedLead): boolean => (l.proof === 'confirmed' || l.proof === 'listed') && signalSeen(l)

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// The company is on the page when its name appears, or when the words of its name (ignoring very short ones) all do.
export function companyOnPage(company: string, page: string): boolean {
  const c = fold(company), p = ` ${fold(page)} `
  if (!c) return false
  if (p.includes(` ${c} `)) return true
  const words = c.split(' ').filter(w => w.length > 2)
  return words.length > 0 && words.every(w => p.includes(` ${w} `))
}
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
  const quote = lead.evidence_quote ? fold(lead.evidence_quote) : ''
  return { ...lead, ...dated(lead, page_age, now), proof: companyOnPage(lead.company, body) ? 'confirmed' : 'company_not_on_page', proof_read_by: by, page_age,
    quote_on_page: quote.length >= 12 && fold(body).includes(quote), date_on_page: dayOnPage(lead.signal_date, body) }
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
  return { ...base, proof: hit && companyOnPage(lead.company, hit.title ?? '') ? 'listed' : 'unseen' }
}

export async function checkLeads(leads: DiscoveredLead[], seen: SeenPage[] = [], fetchImpl: typeof fetch = fetch, concurrency = 4): Promise<CheckedLead[]> {
  const out: CheckedLead[] = new Array(leads.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, leads.length) }, async () => {
    for (let i = next++; i < leads.length; i = next++) out[i] = await checkLead(leads[i], seen, fetchImpl)
  }))
  return out
}
