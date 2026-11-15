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
import { eventYears } from './date-in-text.ts'

export const POSTING_ASK = /\b(?:post(?:s|ed|ing)?|publish(?:es|ed|ing)?|wr(?:ites|ote|iting)|blog(?:s|ged|ging)?)\s+(?:about|on)\b/i
// a sentence ends at . ! ? after a word of two or more letters ("U.S." does not end it)
const firstSentence = (s: string) => (s.split(/(?<=[a-z0-9]{2}[.!?])\s+(?=[A-Z])|\n+/)[0] ?? '')
// (review) the post must be the request's ONLY event, and asked for, not excluded: "opened an office or are posting about X" names another event the post would
// wrongly date; "not posting about X" / "excluding companies posting about X" asks for the opposite.
const NEGATED = /\b(?:not|no|never|without|excluding|exclude[sd]?|except|other than|rather than|instead of)\b/i
const OTHER_EVENT = /\b(?:open(?:s|ed|ing)?|hir(?:e|es|ed|ing)|recruit\w*|rais(?:e|es|ed|ing)|launch\w*|expand\w*|acquir\w*|merg\w*|relocat\w*|mov(?:e|es|ed|ing)|appoint\w*|join(?:s|ed|ing)?|announc\w*|sign(?:s|ed|ing)|won|wins?|award\w*|fund(?:ed|ing)|grow(?:s|n|ing)?|grew|adopt\w*|switch\w*|migrat\w*|start(?:s|ed|ing)|clos(?:e|es|ed|ing)|order\w*|buy\w*|bought|partner(?:s|ed|ing))\b/i
const ANOTHER_CLAUSE = /\b(?:or|and)\s+(?:that|who|which|are|is|have|has|had|were|was)\b/i
export function asksForPost(request: string | null | undefined): boolean {
  if (!request) return false
  const sentence = firstSentence(request), m = POSTING_ASK.exec(sentence)
  if (!m) return false
  const before = sentence.slice(0, m.index), after = sentence.slice(m.index + m[0].length)
  return !NEGATED.test(before) && !OTHER_EVENT.test(before) && !ANOTHER_CLAUSE.test(after)
}

const SLD = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ltd', 'plc', 'id', 'asn'])
export function domainLabel(url: string): string | null {
  let host: string
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, '') } catch { return null }
  const parts = host.split('.').filter(Boolean)
  if (parts.length < 2) return null
  if (parts.length >= 3 && parts[parts.length - 1].length === 2 && SLD.has(parts[parts.length - 2])) return parts[parts.length - 3]
  return parts[parts.length - 2]
}
// a platform's name is not a company's own site: medium.com/@someone, linkedin.com/pulse/... are users' posts
const PLATFORMS = new Set(['medium', 'linkedin', 'substack', 'wordpress', 'blogger', 'blogspot', 'tumblr', 'facebook', 'instagram', 'twitter', 'youtube', 'github', 'wix', 'wixsite', 'squarespace', 'ghost', 'hashnode', 'dev', 'reddit', 'quora', 'hubspot', 'weebly', 'notion', 'beehiiv', 'tiktok'])
const compact = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
// legal forms companyKey keeps (it drops inc / ltd / llc / co ...): an Australian "Pty Ltd" or a German "GmbH" is not part of the domain
const LEGAL = new Set(['pty', 'proprietary', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv', 'srl', 'spa', 'oy', 'ab', 'as', 'aps', 'kg', 'ug', 'pte', 'pvt', 'private', 'sdn', 'bhd', 'kk'])
export function isOwnSite(url: string, company: string): boolean {
  const label = domainLabel(url), key = compact(companyKey(company).split(' ').filter(w => !LEGAL.has(w)).join(' '))
  return !!label && key.length >= 4 && label === key && !PLATFORMS.has(label)
}

const LISTING = /\/(?:tags?|categor(?:y|ies)|authors?|archives?|search|page|feed|topics?)(?:\/|$)/i
export function isArticleAddress(url: string): boolean {
  let path: string
  try { path = new URL(url).pathname } catch { return false }
  if (LISTING.test(path)) return false
  const last = path.split('/').filter(Boolean).pop() ?? ''
  return last.replace(/\.[a-z0-9]{2,5}$/i, '').split(/[-_]+/).filter(w => /[a-z]/i.test(w)).length >= 3
}
// (review) a slug alone does not make a post: /services/cold-email-outreach and /careers/senior-sales-rep have one too. The page must also say it is an article:
// a schema.org article node, or an address under the site's blog / news section.
const ARTICLE_TYPES = /^(?:Article|BlogPosting|NewsArticle|TechArticle|OpinionNewsArticle|AnalysisNewsArticle|ReportageNewsArticle|SocialMediaPosting|Report|ScholarlyArticle|LiveBlogPosting)$/
const POST_SECTION = /\/(?:blogs?|news|insights|articles?|posts?|journal|stories|newsroom|press|updates|resources\/blog)\//i
export function looksLikePost(url: string, blocks: string[] | undefined): boolean {
  try { if (POST_SECTION.test(new URL(url).pathname)) return true } catch { return false }
  for (const raw of blocks ?? []) {
    let j: unknown
    try { j = JSON.parse(raw) } catch { continue }
    for (const o of allNodes(j)) { const t = o['@type']; if ((Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && ARTICLE_TYPES.test(x))) return true }
  }
  return false
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

const BYLINE_CHARS = 1500
const nearQuote = (text: string, quote: string): string => { const at = text.toLowerCase().indexOf(quote.replace(/\s+/g, ' ').toLowerCase().slice(0, 60)); return at < 0 ? '' : text.slice(Math.max(0, at - 300), at + 300) }
// any time expression of the quote's own: a month name (not the modal "may"), a season, a quarter, a relative period, an ISO or numeric day
const OWN_TIME = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:\s+\d|\s+(?:19|20)\d\d|,)|\bmay\s+(?:\d|(?:19|20)\d\d)|\b(?:spring|summer|autumn|fall|winter|q[1-4]|quarter|last (?:week|month|year)|this (?:week|month|year)|years? ago|months? ago|weeks? ago|since|recently|previously|originally|back in|earlier this)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/i
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
  if (!isArticleAddress(i.url) || !looksLikePost(i.url, i.page.structured)) return no('not a single article')
  const pub = i.page.published && /^\d{4}-\d{2}-\d{2}$/.test(i.page.published) ? i.page.published : null
  if (!pub) return no('no single publication day in the page\'s own markup')
  const earlier = earlierStamp(i.page.structured, pub)
  if (earlier) return no(`the page carries an earlier ${earlier}: republished or backdated`)
  const text = i.page.text.replace(/\s+/g, ' ')
  const q = norm(i.excerpt).slice(0, 120), nt = norm(text), at = q.length >= 20 ? nt.indexOf(q) : -1
  if (at < 0) return no('the quote is not on this page')
  // (review) the byline: near the top of the page (title, author, day) or next to the quote, not a "recent posts" list further down
  if (!statesDay(text.slice(0, BYLINE_CHARS), pub) && !statesDay(nearQuote(text, i.excerpt), pub)) return no(`the visible text does not state ${pub} as the post's byline`)
  // (review) a quote that dates its own story ("Back in March 2023 we opened our Melbourne office") is about that story, not the post: held
  if (OWN_TIME.test(i.excerpt) || eventYears(i.excerpt).some(y => String(y) !== pub.slice(0, 4))) return no('the quote dates its own event')
  return { date: pub, why: `the company's own post on its own site, published ${pub} (its markup and its visible byline agree); the request asks for a post, so the post's day is the event day` }
}
