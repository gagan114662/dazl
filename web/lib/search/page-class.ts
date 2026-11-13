// Which kind of page a search result is, for ordering the scarce fetch slots (16 of ~80 results). Pure; no network.
// A request that needs an event BEYOND hiring (seed funding, an opening, an expansion) cannot be satisfied by a job posting alone:
// the posting only corroborates the hiring half. Large companies' postings on ATS boards are dated and in-window, so ordering by
// date alone fills every slot with them while the (often undated) news and company pages that carry the event are never read.

const JOB_HOST = /^(?:(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io|jobs\.(?:ashbyhq\.com|lever\.co|smartrecruiters\.com|workable\.com)|apply\.workable\.com|[a-z0-9-]+\.bamboohr\.com|[a-z0-9-]+\.recruitee\.com|[a-z0-9-]+\.breezy\.hr|(?:[a-z0-9-]+\.)?(?:indeed|glassdoor|reed|totaljobs|cv-library|monster|ziprecruiter)\.[a-z.]+|wellfound\.com|(?:www\.)?linkedin\.com)$/i
const JOB_PATH = /\/(?:jobs?|careers?|vacanc(?:y|ies)|positions?|openings?|job-?listings?|viewjob|apply)(?:\/|$|\?)/i

export function isJobPage(rawUrl: string): boolean {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (JOB_HOST.test(host) && (host !== 'linkedin.com' || /\/jobs\//i.test(u.pathname))) return true
  return JOB_PATH.test(u.pathname)
}

// The request asks for a signal that a job posting cannot show on its own.
const EVENT_SIGNAL = /\b(?:fund(?:ing|ed)?|raise[sd]?|raising|seed|pre-?seed|series\s+[a-e]|round|invest(?:ment|ed|or)?|valuation|expan(?:d|ds|ded|sion|ding)|open(?:s|ed|ing)?\s+(?:a\s+|its\s+|new\s+)|new\s+(?:location|office|branch|clinic|store|site)|launch(?:es|ed)?|announce[sd]?|acquir(?:es|ed|ition)|partnership|contract\s+win)\b/i
const HIRING_ONLY = /\b(?:hiring|hire|recruit(?:ing)?|job|jobs|role|roles|position|positions|vacanc(?:y|ies)|opening|openings)\b/gi
export function needsEventBeyondHiring(signals: string[] | undefined, query: string): boolean {
  const text = [...(signals ?? []), query].join(' . ')
  return EVENT_SIGNAL.test(text.replace(HIRING_ONLY, ' '))
}

// The text shows an event beyond hiring (funding, an opening, an expansion, a launch ...), ignoring the hiring words themselves.
// #878: an opening worded noun-first ("New dental clinic now open in Parkdale", "Our 5th location is now open", "Grand
// opening of our new clinic"). Strict, because a looser reading turned opening hours, job ads and future openings into
// openings (review on #1130): the premises noun must be followed by the open verb ("is now open", "opened"); the words
// between the qualifier and the noun are adjectives only (never and / or / patients / team / manager ...); the place
// clause names no one ("by ..."); and "open" is not followed by days, hours, availability ("for bookings"), a future
// marker ("next", "soon", "in May") or "by <someone>". A grand opening is only "of our / its / their new <premises>".
// One source for both readers (targeting.ts EVENTS 'open' adds it as its noun-first alternatives): capture group 1 is the
// noun of the noun-first form, group 2 the noun of the grand-opening form.
const NF_LEAD = String.raw`(?:brand\s+)?(?:new|our\s+(?:new|second|third|fourth|fifth|\d+(?:st|nd|rd|th))|second|third|fourth|fifth|\d+(?:st|nd|rd|th))`
const NF_FILL = String.raw`(?:(?!(?:and|or|with|for|to|of|the|a|an|is|are|patients?|team|teams|manager|managers|staff|hours?|sales|role|roles|job|jobs)\b)[a-z]+\s+){0,2}?`
const NF_NOUN = String.raw`(locations?|offices?|clinics?|stores?|branch(?:es)?|restaurants?|studios?|practices?|warehouses?|showrooms?|shops?|gyms?|salons?)`
const NF_PLACE = String.raw`(?:\s+(?:in|at|on)\s+(?:(?!\b(?:by|from|of)\b)[^.!?;,]){1,60}?)?`
const NF_VERB = String.raw`\s+(?:is\s+|are\s+|has\s+|have\s+)?(?:now\s+|officially\s+|finally\s+)*(?:open|opened)\b`
// The candidate shapes; every match is then checked by nounFirstOk (an allow-list on what follows, in code, case-aware).
export const NOUN_FIRST_OPEN_SRC = String.raw`\b${NF_LEAD}\s+${NF_FILL}${NF_NOUN}\b${NF_PLACE}${NF_VERB}|\bgrand\s+opening\s+of\s+(?:our|its|their)\s+(?:new\s+)?${NF_FILL}${NF_NOUN}\b`
const TIME_WORDS = /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d+\s*[-–]\s*\d+|\d+\s*\/\s*7|hours?|days?|week|weekends?|weekdays?|daily|nightly|tonight|today|tomorrow|soon|next|until|till|again|re-?open\w*|year-?round|around\s+the\s+clock|summer|winter|spring|autumn|fall|every|all|patients?|walk-?ins?|bookings?|appointments?|registration|enrol\w*|business|house|late|early|evenings?|mornings?)\b/i
const DAY_MONTH = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/i
const FUTURE = /\b(?:will|would|coming|upcoming|join\s+us|is\s+on|on\s+(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|this\s+(?:mon|tue|wed|thu|fri|sat|sun|week|month|coming)\w*|tomorrow|soon|next|later)\b/i
// The clause a match sits in (to the next . ! ? ; or the end), and whether it is a question.
function clauseAt(text: string, from: number): { rest: string; question: boolean; start: string } {
  const head = text.slice(0, from), lastStop = Math.max(head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'), head.lastIndexOf(';'))
  const tail = text.slice(from), stop = tail.search(/[.!?;]/)
  return { rest: stop < 0 ? tail : tail.slice(0, stop), question: stop >= 0 && tail[stop] === '?', start: text.slice(lastStop + 1, from) }
}
// #878 allow-list (review on #1130): a noun-first match is an opening only when what follows the open verb is nothing more
// (end of clause, "its doors"), or a place: "in / at / on <Capitalised name>" with no time, availability, future or
// reopening word in it. A question never is. Another company's name in the match ("New Smile Co clinic is now open":
// a capitalised filler word while the premises noun is lower case) or after "from / of / by" is not this company's.
// A grand opening counts only with no future marker, day, month or number in its clause.
export function nounFirstOk(text: string, m: RegExpMatchArray): boolean {
  const at = m.index ?? 0, end = at + m[0].length
  const c = clauseAt(text, end)
  if (c.question) return false
  const body = m[0]
  if (/^grand\s+opening/i.test(body)) return !FUTURE.test(c.rest) && !/\d/.test(c.rest) && !c.rest.split(/\W+/).some(w => DAY_MONTH.test(w)) && !/\b(?:of|by|from)\s+[A-Z]/.test(c.rest)
  // a capitalised word between the qualifier and a lower-case premises noun is a name ("New Smile Co clinic")
  const words = body.split(/\s+/), noun = words.findIndex(w => /^(?:locations?|offices?|clinics?|stores?|branch(?:es)?|restaurants?|studios?|practices?|warehouses?|showrooms?|shops?|gyms?|salons?)$/i.test(w))
  if (noun > 0 && /^[a-z]/.test(words[noun]) && words.slice(1, noun).some(w => /^[A-Z]/.test(w) && !/^(?:New|Our|Brand)$/.test(w))) return false
  if (/\b(?:by|from|of)\s+[A-Z]/.test(body) || /\b(?:by|from)\s+[A-Z]/.test(c.rest)) return false
  const rest = c.rest.trim()
  if (rest === '' || /^[,:]/.test(rest) || /^(?:its|their)\s+doors\b/i.test(rest)) return !(rest.startsWith(',') && TIME_WORDS.test(rest)) && !FUTURE.test(rest)
  const place = /^(?:in|at|on)\s+([A-Z][\w'-]*)/.exec(rest)
  return !!place && !DAY_MONTH.test(place[1]) && !TIME_WORDS.test(rest) && !FUTURE.test(rest) && !/\d{4}/.test(rest)
}
const NOUN_FIRST_OPEN_G = new RegExp(NOUN_FIRST_OPEN_SRC, 'gi')
// Where the first accepted noun-first opening starts in the text, or -1.
export function nounFirstOpenAt(text: string): number {
  for (const m of text.matchAll(NOUN_FIRST_OPEN_G)) if (nounFirstOk(text, m)) return m.index ?? 0
  return -1
}
export const NOUN_FIRST_OPEN = { test: (text: string): boolean => nounFirstOpenAt(text) >= 0 }
export const showsEventBeyondHiring = (text: string): boolean => EVENT_SIGNAL.test(text.replace(HIRING_ONLY, ' ')) || NOUN_FIRST_OPEN.test(text)

// Funding specifically (a request for "seed funding" is not met by "opening a second office").
const FUNDING = /\b(?:fund(?:ing|ed|raise|raising)?|raise[sd]?|raising|seed|pre-?seed|series\s+[a-e]|round|invest(?:ment|ed|or|ors)?|valuation)\b/i
export const mentionsFunding = (text: string): boolean => FUNDING.test(text)
