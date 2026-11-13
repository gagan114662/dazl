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
const NF_PLACE = String.raw`(?:\s+(?:in|at|on)\s+(?!(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|week(?:end|day)s?\b)(?:(?!\bby\b)[^.!?;,]){1,60}?)?`
const NF_VERB = String.raw`\s+(?:is\s+|are\s+|has\s+|have\s+)?(?:now\s+|officially\s+|finally\s+)*(?:open|opened)\b`
const NF_NOT_AFTER = String.raw`(?!\s+(?:(?:on|at|over)\s+(?:the\s+)?)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|week(?:end|day)s?|evenings?|mornings?|nights?)\b|\s+(?:late|early|daily|nightly|24|until|till|from\s+\d|for\s+(?:registration|bookings?|appointments?|business|enrol\w*)|soon|next|by|in\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)|\s*[-–]\s*\d)`
export const NOUN_FIRST_OPEN_SRC = String.raw`\b${NF_LEAD}\s+${NF_FILL}${NF_NOUN}\b${NF_PLACE}${NF_VERB}${NF_NOT_AFTER}|\bgrand\s+opening\s+of\s+(?:our|its|their)\s+(?:new\s+)?${NF_FILL}${NF_NOUN}\b(?!\s+(?:soon|next|in\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|this\s+coming)|\s+(?:of|by)\s+[A-Z])`
export const NOUN_FIRST_OPEN = new RegExp(NOUN_FIRST_OPEN_SRC, 'i')
export const showsEventBeyondHiring = (text: string): boolean => EVENT_SIGNAL.test(text.replace(HIRING_ONLY, ' ')) || NOUN_FIRST_OPEN.test(text)

// Funding specifically (a request for "seed funding" is not met by "opening a second office").
const FUNDING = /\b(?:fund(?:ing|ed|raise|raising)?|raise[sd]?|raising|seed|pre-?seed|series\s+[a-e]|round|invest(?:ment|ed|or|ors)?|valuation)\b/i
export const mentionsFunding = (text: string): boolean => FUNDING.test(text)
