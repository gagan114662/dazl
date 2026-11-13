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
const NF_FILL = String.raw`(?:(?!(?:and|or|with|for|to|of|the|a|an|is|are|patients?|team|teams|manager|managers|staff|hours?|sales|role|roles|job|jobs)\b)[a-z]+\s+){0,4}?`   // up to 4: a lead's own 3-word name fits ("Our new Metro City Dentistry clinic"); the words are checked (sales-hiring-gate openingAttributable)
const NF_NOUN = String.raw`(locations?|offices?|clinics?|stores?|branch(?:es)?|restaurants?|studios?|practices?|warehouses?|showrooms?|shops?|gyms?|salons?)`
const NF_PLACE = String.raw`(?:\s+(?:in|at|on)\s+(?:(?!\b(?:by|from|of)\b)[^.!?;,]){1,60}?)?`
const NF_VERB = String.raw`\s+(?:is\s+|are\s+|has\s+|have\s+)?(?:now\s+|officially\s+|finally\s+)*(?:open|opened)\b`
// The candidate shapes; every match is then checked by nounFirstOk (an allow-list on what follows, in code, case-aware).
export const NOUN_FIRST_OPEN_SRC = String.raw`\b${NF_LEAD}\s+${NF_FILL}${NF_NOUN}\b${NF_PLACE}${NF_VERB}|\bgrand\s+opening\s+of\s+(?:our|its|their)\s+(?:new\s+)?${NF_FILL}${NF_NOUN}\b`
const TIME_WORDS = /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}\s*(?:[-–]|to)\s*\d{1,2}\b|\d+\s*\/\s*7|\d+(?:st|nd|rd|th)\b|q[1-4]|hours?|days?|weeks?|weekends?|weekdays?|months?|daily|nightly|tonight|today|tomorrow|soon|next|until|till|again|re-?open\w*|year-?round|around\s+the\s+clock|summer|winter|spring|autumn|fall|holidays?|during|sharp|ago|every|all\s+(?:day|week|year|summer|winter)|walk-?ins?|bookings?|appointments?|registration|enrol\w*|house|late|early|evenings?|mornings?|afternoons?|only)\b/i
const DAY_MONTH = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?s?$|^(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$|^may$/i
const FUTURE = /\b(?:will|would|coming|upcoming|join\s+us|is\s+on|starting|beginning|from\s+(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|this\s+(?:mon|tue|wed|thu|fri|sat|sun|week|month|coming)\w*|tomorrow|tonight|soon|next|later)\b/i
const PAST_YEAR = /\b(?:19|20)\d{2}\b(?!\s+[A-Za-z]+\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|lane|ln|cres|crescent|ct|court|pkwy|hwy)\b)/i
const SAID = /\b(?:said|says|according\s+to|per)\s+[A-Z]/
const PREMISES = /^(?:locations?|offices?|clinics?|stores?|branch(?:es)?|restaurants?|studios?|practices?|warehouses?|showrooms?|shops?|gyms?|salons?)$/i
const anyDayMonth = (t: string) => t.split(/[^A-Za-z]+/).some(w => DAY_MONTH.test(w))
const NOT_PLACE = /^(?:a|an|the|one|two|three|four|five|six|few|some|several|couple|many|time|order|person|line|style|business|session|progress|stages?|phases?|christmas|easter|thanksgiving|halloween|hanukkah|diwali|ramadan|eid)$/i
// The words a caption may put between "new" and the premises when it has no case to tell a name by (Title Case, ALL CAPS,
// all lower case): the lead's own name, or one of these.
// generic words a lead's name may carry (they never tell two practices apart)
const LEAD_GENERIC = new Set(['inc', 'ltd', 'llc', 'limited', 'plc', 'the', 'co', 'corp', 'group', 'and', 'of', 'dental', 'dentistry', 'clinic', 'clinics', 'dds', 'dmd', 'centre', 'center', 'studio', 'studios'])
export const PREMISES_ADJ = /^(?:dental|dentistry|medical|family|pediatric|paediatric|orthodontic|cosmetic|veterinary|vet|physio|physiotherapy|chiropractic|wellness|health|beauty|hair|nail|fitness|flagship|downtown|uptown|larger|bigger|expanded|modern|beautiful|main|second|third|fourth|fifth|satellite|community|walk-in|urgent|care|retail|pop-up|popup)$/i
const STREET = /^\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+)?\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|lane|ln|cres|crescent|ct|court|pkwy|hwy|w|e|n|s)\b/i
// A place after in / at / on: a street address, "the heart of <Name>", or a proper name (capitalised in mixed-case text;
// in all-lower or all-caps text, a word that is not an article, number or common noun).
function placeOk(rest: string, text: string): boolean {
  const after = rest.replace(/^(?:in|at|on)\s+/i, '')
  if (STREET.test(after)) return true
  const w = (/^the\s+heart\s+of\s+(\S+)/i.exec(after) ?? /^(\S+)/.exec(after))?.[1]?.replace(/[^A-Za-z'-]/g, '') ?? ''
  if (!w || NOT_PLACE.test(w) || DAY_MONTH.test(w)) return false
  const mixed = /[a-z]/.test(text) && /[A-Z]/.test(text)
  return mixed ? /^[A-Z]/.test(w) : true
}
// The clause a match sits in (to the next . ! ? ; or the end), and whether it is a question.
function clauseAt(text: string, from: number): { rest: string; question: boolean } {
  const tail = text.slice(from), stop = tail.search(/[.!?;]/)
  return { rest: stop < 0 ? tail : tail.slice(0, stop), question: stop >= 0 && tail[stop] === '?' }
}
// #878 (reviews on #1130 at 57008172, 519f060c and 77e509ac): the opened PLACE reported closed, shut or moved. Read for the
// new opening forms only. Anywhere in the quote, only a standalone banner counts: a line, sentence, bracket, or a part
// between dashes, commas, "·", "•", "|" or "but", that is just "Permanently closed", "Temporarily closed", "Closed
// permanently", "CLOSED" / "Closed", "(closed)", "[closed]", "It has since closed", "since closed", "has moved", "It closed
// in March", "we have closed it" ("Our new clinic is now open in Parkdale · Permanently closed · Dentist"). "Our old Boston
// office has closed" and "Applications are now closed" are not banners.
const CLOSED_BANNER = /^(?:(?:it|we|they)\s+)?(?:(?:has|have)\s+(?:since\s+|now\s+)?(?:permanently\s+)?(?:closed|shut\s*down|moved|relocated)(?:\s+(?:it|down|permanently|for\s+good))?|since\s+(?:closed|moved|relocated)|(?:now\s+)?(?:permanently|temporarily)\s+closed|closed(?:\s+(?:permanently|temporarily|for\s+good|until\s+further\s+notice))?)$|^(?:it|we|they)\s+(?:has\s+|have\s+)?closed(?:\s+(?:it|down|in\s+[a-z]+(?:\s+\d{4})?|in\s+\d{4}|last\s+[a-z]+))?$/i
export function closedBanner(quote: string): boolean {
  return quote.split(/[.!?;\n()[\]·•|]|\s[-–—]\s|,|\s(?:but|however)\s/i).map(x => x.trim().replace(/^[-–—:]\s*/, '')).some(x => x !== '' && CLOSED_BANNER.test(x) && (x !== 'closed' || /[([]\s*closed\s*[)\]]/.test(quote)))
}
// Inside the opening's own clause: closed / shut / moved / relocated only with nothing following it (end of clause,
// punctuation) or a "permanently / temporarily / for good / until" qualifier, plus "closed its doors" and "no longer open".
// "has closed a $5M round", "shut down its legacy product", "relocated its HQ", "moved to a new HQ" are no closure.
export const CLAUSE_CLOSED = /\b(?:closed\s+(?:its|our|their|the)\s+doors|no\s+longer\s+open|(?:(?:has|have)\s+(?:since\s+)?|since\s+|now\s+|permanently\s+|temporarily\s+)(?:closed|shut\s*down|moved|relocated)(?=\s*(?:$|[,.;:!?)\]–—-]|permanently\b|temporarily\b|for\s+good\b|until\b))|(?:closed|shut\s*down|relocated|moved)\s+(?:permanently|temporarily|for\s+good|until\s+further\s+notice)\b)/i
// #878 allow-list (reviews on #1130). A noun-first match is an opening only when what follows the open verb is:
//   - nothing more (end of clause), "its/their doors", "for business", "and accepting / welcoming / serving ...", or
//     "- <words>" / ", <words>" / ": <words>" with no hours, availability, future, day, month or "said <Name>";
//   - a place: "in / at / on <name or street number>" (any case) with no hours, availability, future word, day or month
//     name anywhere in it, and no past year (19xx / 20xx that is not a street number).
// Never a question. A grand opening only with none of those hours / future / day / month / year marks in its clause.
// With the lead's company known, a capitalised word between the qualifier and a lower-case premises noun is another
// company's name ("New Smile Co clinic"), unless it is a word of the lead's own name or sits right before the noun
// ("Our new Woodbridge location", a place); without it (request compilation, page classification) that check is left to
// the company-aware reader (sales-hiring-gate.ts quoteShowsEvent).
export function nounFirstOk(text: string, m: RegExpMatchArray, company?: string | null): boolean {
  const at = m.index ?? 0, end = at + m[0].length
  const c = clauseAt(text, end)
  if (c.question) return false
  // the place reported closed, shut or moved ("now open in Parkdale (closed permanently)", "- temporarily closed"): not an opening
  if (CLAUSE_CLOSED.test(c.rest)) return false
  const body = m[0], rest = c.rest.trim()
  const clean = (t: string) => !TIME_WORDS.test(t) && !FUTURE.test(t) && !anyDayMonth(t) && !PAST_YEAR.test(t) && !SAID.test(t)
  // case tells a name apart only in ordinary text: not in ALL CAPS, all lower case or a Title Case caption (every word of the match capitalised)
  const mixed = /[a-z]/.test(text) && /[A-Z]/.test(text) && !m[0].split(/\s+/).every(w => /^[A-Z0-9]/.test(w))
  if (/\b(?:by|from|of)\s+[A-Z]/.test(body) || /\b(?:by|from)\s+[A-Z]/.test(rest)) return false
  if (!mixed && (/\b(?:by|from)\s+[a-z]/i.test(body + ' ' + rest))) return false
  if (/^grand\s+opening/i.test(body)) return clean(rest) && !/\b(?:of|by)\s+[A-Z]/.test(rest)
  if (company) {
    const own = new Set(company.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
    const words = body.split(/\s+/), noun = words.findIndex(w => PREMISES.test(w))
    // R17: a fill carrying any of the lead's words must be the lead's whole name ("New Metro Dental Clinic" is not Metro
    // City Dentistry): its words, less frame words and premises adjectives that are not the lead's, are the lead's core
    const fill = noun > 0 ? words.slice(1, noun).map(w => w.toLowerCase().replace(/[^a-z0-9&'-]/g, '')).filter(w => w !== '' && !/^(?:new|our|brand)$/.test(w)) : []
    if (fill.some(w => own.has(w) && !PREMISES_ADJ.test(w) && !LEAD_GENERIC.has(w))) {
      const core = (ws: string[]) => ws.filter(w => !LEAD_GENERIC.has(w)).join(' ')
      if (core(fill.filter(w => own.has(w) || !PREMISES_ADJ.test(w))) !== core([...own])) return false
    }
    // no case to tell a name by: every word between the qualifier and the noun is the lead's own name or a premises adjective
    if (!mixed && noun > 0 && words.slice(1, noun).some(w => !/^(?:new|our|brand)$/i.test(w) && !own.has(w.toLowerCase()) && !PREMISES_ADJ.test(w))) return false
    // the word right before the noun is a place ("Our new Woodbridge location") only after "our" or the lead's own name
    const ours = words.slice(0, Math.max(0, noun - 1)).some(w => /^our$/i.test(w) || own.has(w.toLowerCase()))
    // in mixed-case text a capitalised word before the noun is a name, whatever the noun's case ("New Bright Smiles Clinic")
    if (mixed && noun > 0 && words.slice(1, noun).some((w, k) => /^[A-Z]/.test(w) && !/^(?:New|Our|Brand)$/.test(w) && !own.has(w.toLowerCase()) && !(ours && k + 1 === noun - 1))) return false
  }
  if (rest === '' || /^(?:its|their)\s+doors\b/i.test(rest) || /^for\s+business\b/i.test(rest)) return clean(rest.replace(/^(?:its|their)\s+doors\b|^for\s+business\b/i, ''))
  if (/\bfor\s+(?:[a-z]+\s+){0,2}[A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*)*\s+(?:patients|clients|customers|members)\b/.test(rest)) return false
  if (/^and\s+(?:accepting|welcoming|serving|ready)\b/i.test(rest)) return !FUTURE.test(rest) && !anyDayMonth(rest) && !SAID.test(rest) && !PAST_YEAR.test(rest) && !/\b(?:ago|since)\b/i.test(rest)
  if (/^[,:–-]/.test(rest)) return clean(rest)
  return /^(?:in|at|on)\s+/i.test(rest) && placeOk(rest, text) && clean(rest)
}
const NOUN_FIRST_OPEN_G = new RegExp(NOUN_FIRST_OPEN_SRC, 'gi')
// Where the first accepted noun-first opening is in the text ([start, end]), or null.
export function nounFirstOpenSpan(text: string, company?: string | null): [number, number] | null {
  for (const m of text.matchAll(NOUN_FIRST_OPEN_G)) if (nounFirstOk(text, m, company)) return [m.index ?? 0, (m.index ?? 0) + m[0].length]
  return null
}
// Where the first accepted noun-first opening starts in the text, or -1.
export function nounFirstOpenAt(text: string, company?: string | null): number { return nounFirstOpenSpan(text, company)?.[0] ?? -1 }
export const NOUN_FIRST_OPEN = { test: (text: string): boolean => nounFirstOpenAt(text) >= 0 }
// The event signal as it was before #878 (no noun-first openings): a non-opening event is read with this, unchanged.
export const showsEventSignal = (text: string): boolean => EVENT_SIGNAL.test(text.replace(HIRING_ONLY, ' '))
export const showsEventBeyondHiring = (text: string): boolean => showsEventSignal(text) || NOUN_FIRST_OPEN.test(text)

// Funding specifically (a request for "seed funding" is not met by "opening a second office").
const FUNDING = /\b(?:fund(?:ing|ed|raise|raising)?|raise[sd]?|raising|seed|pre-?seed|series\s+[a-e]|round|invest(?:ment|ed|or|ors)?|valuation)\b/i
export const mentionsFunding = (text: string): boolean => FUNDING.test(text)
