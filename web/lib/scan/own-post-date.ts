// #878 / #1107 (event dates): when the request asks for companies that POSTED about something ("Marketing agencies in Sydney posting about outbound, cold email
// or lead generation in the last 90 days"), the event IS the post, and a company's own post carries its day. On the prod matrix of 2026-11-14 (3fb162e5) four of
// the six undated Sydney leads were exactly that: the agency's own article on its own domain (digitalsymantec.com, outbounda.io, davideid.co, sagarsethi.com.au),
// the day in the page's own markup AND in its visible byline, and dazl held every one as "a publication date only - the event date is unknown".
//
// For any other request a publication day is a label only (page-timing.ts): a story can be published long after the event it reports. Here it is the event day
// itself, so it may date the lead - but only when every one of these holds, and the lead is held as before on any doubt:
//   - the request's first sentence asks for a post (posting / posted / publishing / writing / blogging ... about | on);
//   - the page is the company's OWN site: its registrable domain label is the company's name (spaces and punctuation removed). A post ABOUT the company on someone
//     else's site (a news story, a roundup, a directory) is never dated here;
//   - the page is one article: its address ends in a slug of at least three words, and is not a tag / category / author / archive / search / page-N listing;
//   - the page's own markup gives exactly one publication day (fetch-page.ts `published`), and no JSON-LD dateCreated / dateModified / datePublished on the page
//     is earlier than it (a republished or backdated piece is held);
//   - the visible text states that same day (the post's byline). A byline that shows another day (time zones: 3 Oct in UTC markup, 4 Oct on an Australian page)
//     is held rather than guessed;
//   - the lead's own quote is on that page (the post it was found in, not another page of the site).
// The day then goes through the same window / stale / future gate as any other date; this decides nothing about the window.
import { companyKey, norm } from './evidence.ts'

export const POSTING_ASK = /\b(?:post(?:s|ed|ing)?|publish(?:es|ed|ing)?|wr(?:ites|ote|iting)|blog(?:s|ged|ging)?)\s+(?:about|on)\b/i
const firstSentence = (s: string) => (s.split(/(?<=[.!?])\s+|\n+/)[0] ?? '')
export const asksForPost = (request: string | null | undefined): boolean => !!request && POSTING_ASK.test(firstSentence(request))

const SLD = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ltd', 'plc', 'id', 'asn'])
export function domainLabel(url: string): string | null {
  let host: string
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, '') } catch { return null }
  const parts = host.split('.').filter(Boolean)
  if (parts.length < 2) return null
  if (parts.length >= 3 && parts[parts.length - 1].length === 2 && SLD.has(parts[parts.length - 2])) return parts[parts.length - 3]
  return parts[parts.length - 2]
}
const compact = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
// legal forms companyKey keeps (it drops inc / ltd / llc / co ...): an Australian "Pty Ltd" or a German "GmbH" is not part of the domain
const LEGAL = new Set(['pty', 'proprietary', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv', 'srl', 'spa', 'oy', 'ab', 'as', 'aps', 'kg', 'ug', 'pte', 'pvt', 'private', 'sdn', 'bhd', 'kk'])
export function isOwnSite(url: string, company: string): boolean {
  const label = domainLabel(url), key = compact(companyKey(company).split(' ').filter(w => !LEGAL.has(w)).join(' '))
  return !!label && key.length >= 4 && label === key
}

const LISTING = /\/(?:tags?|categor(?:y|ies)|authors?|archives?|search|page|feed|topics?)(?:\/|$)/i
export function isArticleAddress(url: string): boolean {
  let path: string
  try { path = new URL(url).pathname } catch { return false }
  if (LISTING.test(path)) return false
  const last = path.split('/').filter(Boolean).pop() ?? ''
  return last.replace(/\.[a-z0-9]{2,5}$/i, '').split(/[-_]+/).filter(w => /[a-z]/i.test(w)).length >= 3
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
// The forms a byline writes a day in: 2026-08-23, 23 August 2026, August 23, 2026, 23 Aug 2026, Aug 23 2026, 23/08/2026 is NOT read (day/month order is unknowable).
export function statesDay(text: string, day: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day); if (!m) return false
  const y = m[1], mo = +m[2], d = +m[3], full = MONTHS[mo - 1], short = full.slice(0, 3)
  const mon = `(?:${full}|${short}${full === 'september' ? '|sept' : ''})\\.?`
  const res = [
    new RegExp(`\\b${y}-${m[2]}-${m[3]}\\b`),
    new RegExp(`\\b0?${d}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mon},?\\s+${y}\\b`, 'i'),
    new RegExp(`\\b${mon}\\s+0?${d}(?:st|nd|rd|th)?,?\\s+${y}\\b`, 'i'),
  ]
  return res.some(re => re.test(text))
}

const isoDay = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? v.trim().slice(0, 10) : null
function* allNodes(v: unknown, depth = 0, budget = { n: 400 }): Generator<Record<string, unknown>> {
  if (depth > 6 || budget.n-- <= 0 || v == null || typeof v !== 'object') return
  if (Array.isArray(v)) { for (const x of v) yield* allNodes(x, depth + 1, budget); return }
  const o = v as Record<string, unknown>
  yield o
  for (const x of Object.values(o)) if (x && typeof x === 'object') yield* allNodes(x, depth + 1, budget)
}
// Any stamp on the page that is EARLIER than the publication day: the piece existed before it was "published" (a republication, a backdated or moved post).
export function earlierStamp(blocks: string[] | undefined, published: string): string | null {
  for (const raw of blocks ?? []) {
    let j: unknown
    try { j = JSON.parse(raw) } catch { continue }
    for (const o of allNodes(j)) for (const k of ['dateCreated', 'dateModified', 'datePublished']) { const d = isoDay(o[k]); if (d && d < published) return `${k} ${d}` }
  }
  return null
}

export interface OwnPostInput { request: string | null | undefined; company: string; url: string; excerpt: string; page: { text: string; published?: string | null; structured?: string[] } }
export type OwnPostResult = { date: string; why: string } | { date: null; why: string }
export function ownPostDate(i: OwnPostInput): OwnPostResult {
  const no = (why: string): OwnPostResult => ({ date: null, why })
  if (!asksForPost(i.request)) return no('the request does not ask for a post')
  if (!isOwnSite(i.url, i.company)) return no('not the company\'s own site')
  if (!isArticleAddress(i.url)) return no('not a single article')
  const pub = i.page.published && /^\d{4}-\d{2}-\d{2}$/.test(i.page.published) ? i.page.published : null
  if (!pub) return no('no single publication day in the page\'s own markup')
  const earlier = earlierStamp(i.page.structured, pub)
  if (earlier) return no(`the page carries an earlier ${earlier}: republished or backdated`)
  const text = i.page.text.replace(/\s+/g, ' ')
  if (!statesDay(text, pub)) return no(`the visible text does not state ${pub}`)
  const q = norm(i.excerpt).slice(0, 120)
  if (q.length < 20 || !norm(text).includes(q)) return no('the quote is not on this page')
  return { date: pub, why: `the company's own post on its own site, published ${pub} (its markup and its visible byline agree); the request asks for a post, so the post's day is the event day` }
}
