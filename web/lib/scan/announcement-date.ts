// #1099: two ways a news page dates an event the scan verified but could not date, used ONLY after every other way has failed (structured-date.ts
// finishUndatedLeads: the page's own structured event date and a company's own post come first). Pure; no model, no network.
//
// 1. relativeEventDay: the quote says its own day relative to the page's publication ("Krones on Wednesday inaugurated its new facility", the page
//    published Wednesday 2026-08-19). The publication day only resolves which Wednesday; the day is the event's own, stored page_bound.
// 2. announcementDatelineDay (Hermes decision, 15 Nov 00:50; reverses #460 ONLY in this labelled form): the page that IS the announcement of a completed
//    event ("finmid Raises EUR 17M in Series A Extension Funding", byline October 12, 2026) dates the ANNOUNCEMENT by its own publication day. Stored with
//    date_basis 'announcement_dateline'; every surface says "announced <date>", never that the event happened then.
//
// Both refuse, and the lead stays undated, unless ALL of these hold:
//   - the day comes from the page's own machine-readable publication date (fetch-page.ts `published`, read from its markup), never from a cued line near
//     the quote (a review's "posted" date is not the page's) and never a model's claim; and the page's structured data does not give a different
//     publication or creation day, or any stamp earlier than it;
//   - the quote names the company as a whole phrase and states a COMPLETED event in the past tense with the company as the subject: no relative clause,
//     recap or passive between the company and the verb ("finmid, which previously raised ...", "X was acquired by Y" are refused), no plan or future;
//   - the quote states no day or period of its own (a month, a year, a quarter, "last year", "recently" ...), apart from the one relative day rule 1 reads;
// and, for the dateline only:
//   - the page IS the announcement: its title names the company AND the same kind of event as the quote (funding, an opening, an acquisition, a hire, a
//     launch, a partnership), it is not a profile / directory / about / archive / review / careers page or a roundup, and the quote opens the story (its
//     first 2,500 characters); and no other unambiguous day is printed at the top of the page (its first 800 characters).
import { datePositions } from './date-in-text.ts'
import { earlierStamp } from './own-post-date.ts'
import { companyKey, hasPhrase, norm } from './evidence.ts'

export const DATE_BASIS_DATELINE = 'announcement_dateline'

// past-tense completed verbs, by event kind (the title must name the same kind as the quote)
const KINDS: { kind: string; verb: RegExp; title: RegExp }[] = [
  { kind: 'funding', verb: /\b(?:raised|closed|secured|landed|bagged|eingesammelt|abgeschlossen|erhalten)\b/i, title: /\b(?:rais(?:es|ed|ing)|clos(?:es|ed)|secur(?:es|ed)|lands?|landed|bags?|funding|financing|round|series [a-f]|seed|investment|erhält|erhalten|sammelt|eingesammelt|finanzierung|finanzierungsrunde|millionen)\b/i },
  { kind: 'opening', verb: /\b(?:opened|inaugurated|eröffnet)\b/i, title: /\b(?:open(?:s|ed|ing)?|inaugurat\w*|eröffnet)\b/i },
  { kind: 'acquisition', verb: /\b(?:acquired|bought|übernommen)\b/i, title: /\b(?:acquir\w*|buys|bought|acquisition|übernimmt|übernommen)\b/i },
  { kind: 'hire', verb: /\b(?:hired|appointed|named)\b/i, title: /\b(?:hires?|hired|appoint\w*|names|named)\b/i },
  { kind: 'launch', verb: /\b(?:launched|unveiled|debuted|introduced|gestartet)\b/i, title: /\b(?:launch\w*|unveil\w*|debut\w*|introduc\w*|startet|gestartet)\b/i },
  { kind: 'partnership', verb: /\b(?:signed|partnered)\b/i, title: /\b(?:signs?|signed|partner\w*|deal)\b/i },
]
const FUTURE = /\b(?:will|would|shall|plans?|planned|planning|intends?|intended|aims?|set to|to (?:open|launch|hold|host|start|begin|unveil|raise|acquire|hire|expand)|expected|expects|scheduled|upcoming|next|soon|preparing|prepares|considering|in talks|wird|werden|soll|plant,? (?:ein|eine|einen|den|die|das))\b/i
const MONTH = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januar|februar|märz|mai|juni|juli|oktober|dezember)\b/i
// a period of the quote's own; a bare 4-digit year only as a year (not "2,026 employees" or "€2025")
const OWN_PERIOD = /\b(?:q[1-4]|h[12]|(?:first|second|third|fourth) (?:quarter|half)|(?:last|this|past|previous|next) (?:week|month|year|quarter|spring|summer|fall|autumn|winter)|(?:earlier|later) this (?:week|month|year)|recently|ago|tomorrow|spring|summer|autumn|winter|letztes jahr|kürzlich)\b|(?<![\d,.€$£])\b(?:19|20)\d{2}\b(?![\d,.%])/i
const RELATIVE = /\b(today|yesterday|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i
// between the company and its verb: a relative clause, a recap, a passive or a reported statement means the verb is not the company's own statement
const NOT_OWN_STATEMENT = /\b(?:which|who|whom|whose|that|previously|earlier|first|before|after|since|was|were|been|being|by|said|says|reported|reports|according|die|der|das|welche|welcher|zuvor|bereits)\b/i
const NOT_ANNOUNCEMENT_TITLE = /\b(?:profile|directory|about|archive|reviews?|careers?|jobs?|interview|top \d+|\d+ (?:startups|companies|firms|deals|rounds)|round-?up|digest|newsletter|this week in|weekly|monthly|recap|list of)\b/i
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export interface PageDateInput { quote: string; company: string; title?: string | null; pageText: string; published: string | null | undefined; structured?: string[] }
export type PageDateResult = { day: string; why: string } | { day: null; why: string }

// The company as the subject of a completed past-tense event in the quote: the kind of event, or null with why not.
function ownCompletedEvent(quote: string, company: string): { kind: string } | { kind: null; why: string } {
  const q = norm(quote), key = companyKey(company)
  if (!key || !hasPhrase(q, key)) return { kind: null, why: 'the quote does not name the company' }
  if (FUTURE.test(quote)) return { kind: null, why: 'a plan or future event, not a completed one' }
  const after = q.slice(q.search(new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`)) + key.length + 1)
  for (const k of KINDS) {
    const m = k.verb.exec(after)
    if (!m) continue
    if (NOT_OWN_STATEMENT.test(after.slice(0, m.index))) return { kind: null, why: 'the completed event is not stated by the company itself (a relative clause, a recap, a passive or a report)' }
    return { kind: k.kind }
  }
  return { kind: null, why: 'the quote states no completed event' }
}

function ownPublication(published: string | null | undefined, structured: string[] | undefined): { day: string } | { day: null; why: string } {
  if (!published || !/^\d{4}-\d{2}-\d{2}$/.test(published)) return { day: null, why: 'no machine-readable publication day of the page itself' }
  const earlier = earlierStamp(structured, published)
  if (earlier) return { day: null, why: `the page's structured data has an earlier ${earlier}` }
  for (const raw of structured ?? []) {
    let j: unknown
    try { j = JSON.parse(raw) } catch { continue }
    const stack: unknown[] = [j]
    while (stack.length) {
      const o = stack.pop()
      if (!o || typeof o !== 'object') continue
      if (Array.isArray(o)) { stack.push(...o); continue }
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if ((k === 'datePublished' || k === 'dateCreated') && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && v.slice(0, 10) !== published) return { day: null, why: `the page's structured data gives ${k} ${v.slice(0, 10)}, not ${published}` }
        if (v && typeof v === 'object') stack.push(v)
      }
    }
  }
  return { day: published }
}

// 1. "Krones on Wednesday inaugurated ...", published Wednesday 2026-08-19: 2026-08-19. The latest such day on or before publication.
export function relativeEventDay(i: Omit<PageDateInput, 'title' | 'pageText'> & { pageText?: string }): PageDateResult {
  const pub = ownPublication(i.published, i.structured)
  if (!pub.day) return { day: null, why: (pub as { why: string }).why }
  const q = i.quote.replace(/\s+/g, ' ').trim()
  const m = RELATIVE.exec(q)
  if (!m) return { day: null, why: 'the quote states no relative day' }
  if (/\blast (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b/i.test(q)) return { day: null, why: '"last <day>" does not settle the week' }
  const rest = q.replace(m[0], ' ')
  if (datePositions(rest).length || MONTH.test(rest) || OWN_PERIOD.test(rest) || RELATIVE.test(rest)) return { day: null, why: 'the quote also states another day or period' }
  const ev = ownCompletedEvent(q, i.company)
  if (!ev.kind) return { day: null, why: (ev as { why: string }).why }
  const at = new Date(`${pub.day}T00:00:00Z`)
  const back = m[1].toLowerCase() === 'today' ? 0 : m[1].toLowerCase() === 'yesterday' ? 1 : (at.getUTCDay() - WEEKDAYS.indexOf(m[2].toLowerCase()) + 7) % 7
  const day = new Date(at.getTime() - back * 86_400_000).toISOString().slice(0, 10)
  return { day, why: `"${m[1]}" in the evidence sentence naming this company, counted from the page's own publication day ${pub.day}` }
}

// 2. The page that announces a completed event: the announcement's day, labelled as such.
export function announcementDatelineDay(i: PageDateInput): PageDateResult {
  const pub = ownPublication(i.published, i.structured)
  if (!pub.day) return { day: null, why: (pub as { why: string }).why }
  const q = i.quote.replace(/\s+/g, ' ').trim(), title = (i.title ?? '').replace(/\s+/g, ' ').trim(), key = companyKey(i.company)
  if (!key || !hasPhrase(norm(title), key)) return { day: null, why: 'the page title does not name the company: not its announcement' }
  if (NOT_ANNOUNCEMENT_TITLE.test(title)) return { day: null, why: 'a profile, directory, review, careers, interview or roundup page, not the announcement' }
  if (datePositions(q).length || MONTH.test(q) || OWN_PERIOD.test(q) || RELATIVE.test(q)) return { day: null, why: 'the quote states its own day or period' }
  const ev = ownCompletedEvent(q, i.company)
  if (!ev.kind) return { day: null, why: (ev as { why: string }).why }
  if (!KINDS.find(k => k.kind === ev.kind)!.title.test(title)) return { day: null, why: `the page title does not announce this ${ev.kind}` }
  const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}€$£%]+/gu, ' ').trim()
  const wt = words(i.pageText), wq = words(q).split(' ').slice(0, 10).join(' ')
  const at = wq ? wt.indexOf(wq) : -1
  if (at < 0 || at > 2500) return { day: null, why: 'the quote does not open the story' }
  const conflicting = datePositions(i.pageText.replace(/\s+/g, ' ').slice(0, 800)).find(d => !d.ambiguous && d.day !== pub.day)
  if (conflicting) return { day: null, why: `the page also prints ${conflicting.day}` }
  return { day: pub.day, why: `announced ${pub.day}: the publication day of the page that announces this ${ev.kind}; the event happened on or before it` }
}
