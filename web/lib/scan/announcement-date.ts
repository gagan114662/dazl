// #1099 (Hermes decision, 15 Nov 00:50, reversing #460 ONLY in this labelled form): a page that IS the announcement of a completed event ("finmid raised
// EUR 17m in a Series A extension", on finsmes.com, byline October 12, 2026) dates that event's ANNOUNCEMENT by its own publication day. On the main matrix
// of 14 Nov all three Berlin leads were exactly that, and every one was held "no date" because a publication day is otherwise a label only (page-timing.ts).
//
// The day is stored as an announcement day, never as the day the event happened: the lead carries date_basis 'announcement_dateline' and its copy says
// "announced <date>" (date-copy.ts). It is given only when ALL of these hold, and the lead stays undated on any doubt:
//   1. the page is the announcement of this event: its title names the company, the quote names the company, says a COMPLETED event in the past tense
//      (raised, closed, secured, acquired, opened, launched ...), says no plan or future ("will", "plans to", "set to" ...), and opens the story (it sits in
//      the page's first 2,500 characters); a roundup or digest title ("Top 10 ...", "this week in ...", "funding roundup") is not an announcement;
//   2. the day is the page's own publication day (its markup or a cued "Published"/"Posted" line: resolveTiming's `published`), never a model's guess, and the
//      page does not contradict it: no other unambiguous day printed in its first 800 characters, and no structured date stamp earlier than it;
//   3. the quote states no day or period of its own ("in March", "Q1", "last year", "2025", "recently", "earlier this month" ...): an event that says when it
//      happened is dated by that (or stays undated), never stamped with the story's day (#1211's review: story days on non-announced events);
//   4. it is not a hiring candidate (a job posting is dated by its board, runner.ts).
// Pure; no model, no network.
import { datePositions } from './date-in-text.ts'
import { earlierStamp } from './own-post-date.ts'

export const DATE_BASIS_DATELINE = 'announcement_dateline'

const COMPLETED = /\b(?:(?:has|have|had)\s+)?(?:raised|closed|secured|landed|bagged|completed|opened|inaugurated|acquired|bought|launched|unveiled|debuted|introduced|signed|won|expanded|hired|appointed|named|merged|partnered|announced|eingesammelt|abgeschlossen|erhalten|übernommen|eröffnet|gestartet)\b/i
const FUTURE = /\b(?:will|would|shall|plans?|planned|planning|intends?|intended|aims?|set to|to (?:open|launch|hold|host|start|begin|unveil|raise|acquire|hire|expand)|expected|expects|scheduled|upcoming|next|soon|preparing|prepares|considering|in talks|wird|werden|plant|soll)\b/i
const MONTH = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januar|februar|märz|mai|juni|juli|oktober|dezember)\b/i
const OWN_PERIOD = /\b(?:q[1-4]|h[12]|(?:first|second|third|fourth) (?:quarter|half)|(?:last|this|past|previous|next) (?:week|month|year|quarter|spring|summer|fall|autumn|winter)|(?:earlier|later) this (?:week|month|year)|recently|ago|today|yesterday|tomorrow|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:19|20)\d{2}|spring|summer|autumn|winter|letztes jahr|kürzlich|gestern|heute)\b/i
const ROUNDUP = /\b(?:top \d+|\d+ (?:startups|companies|firms|deals|rounds)|round-?up|digest|newsletter|this week in|weekly|monthly|funding news|deals of the|recap|list of)\b/i

export interface DatelineInput { quote: string; company: string; title: string | null | undefined; pageText: string; published: string | null | undefined; structured?: string[] }
export type DatelineResult = { day: string; why: string } | { day: null; why: string }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

export function announcementDatelineDay(i: DatelineInput): DatelineResult {
  const published = i.published
  if (!published || !/^\d{4}-\d{2}-\d{2}$/.test(published)) return { day: null, why: 'no publication day of the page itself' }
  const q = norm(i.quote), co = norm(i.company), title = norm(i.title ?? ''), text = norm(i.pageText)
  const has = (hay: string) => co.length >= 2 && hay.toLowerCase().includes(co.toLowerCase())
  if (!has(q)) return { day: null, why: 'the quote does not name the company' }
  if (!has(title)) return { day: null, why: 'the page title does not name the company: not its announcement' }
  if (ROUNDUP.test(title)) return { day: null, why: 'a roundup or digest, not the announcement' }
  if (FUTURE.test(q)) return { day: null, why: 'a plan or future event, not a completed one' }
  if (!COMPLETED.test(q)) return { day: null, why: 'the quote states no completed event' }
  if (datePositions(q).length || MONTH.test(q) || OWN_PERIOD.test(q)) return { day: null, why: 'the quote states its own day or period' }
  // where the quote sits, matched on words only ("finmid , a Berlin" on the page is "finmid, a Berlin" in the quote): the verifier has already checked
  // the quote is on the page; this only asks whether it opens the story
  const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}€$£%]+/gu, ' ').trim()
  const wt = words(text), wq = words(q).split(' ').slice(0, 10).join(' ')
  const at = wq ? wt.indexOf(wq) : -1
  if (at < 0 || at > 2500) return { day: null, why: 'the quote does not open the story' }
  const conflicting = datePositions(text.slice(0, 800)).find(d => !d.ambiguous && d.day !== published)
  if (conflicting) return { day: null, why: `the page also prints ${conflicting.day}` }
  const earlier = earlierStamp(i.structured, published)
  if (earlier) return { day: null, why: `the page's structured data has an earlier ${earlier}` }
  return { day: published, why: `announced ${published}: the publication day of the page that announces this event (a completed event named in its title and opening); the event happened on or before it` }
}
