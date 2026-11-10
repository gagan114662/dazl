// Person and contact-route verification (#781, part of #395): is the named contact CURRENT at the company, from pages somebody else fetched.
// Pure: no fetch, no model, no clock (as_of is passed in). Returns what the #394 contract reads as LeadEvidence.contact.person, so a former employee fails
// contact.usable, an unconfirmed one is unknown (never pass), and a generic or hiring inbox fails there too (lib/evals/contract.ts).
//
// Rules, each with a seeded test in test/person-verification.test.ts:
//  - A sentence counts only when it asserts an employment RELATIONSHIP: the person is the subject of the predicate and the company its object (at/with/for/from). A lawsuit, a
//    negation, "replaced X, who left", or a former role at a different company is not evidence either way.
//  - FORMER beats current: any fresh page whose sentence about the person at the company carries a departure cue (former, ex-, left, previously, resigned,
//    stepped down, until <year>, alumni, formerly) makes the person former, even if another page says current.
//  - CURRENT needs a fresh, BOUND date: a present-tense employment sentence whose own text, or the page's labelled posted/published/updated date, states a day within
//    `max_age_days` before as_of (not after it). An unrelated date elsewhere on the page does not count. Undated or stale is unknown, never current.
//  - Unknown stays unknown: no page, no dated page, or no sentence about this person at this company.
import { isDay } from './contract.ts'

export interface PersonClaim { name: string; company: string; title?: string | null }
export interface PersonPage { url: string; text: string }
export interface PersonOptions { as_of: string; max_age_days?: number }
export interface PersonResult { person: 'current' | 'former' | 'unknown'; title_matches: 'pass' | 'unknown'; reason: string; evidence: string[] }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const has = (hay: string, needle: string) => needle.trim() !== '' && ` ${norm(hay)} `.includes(` ${norm(needle)} `)
const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// The calendar days a page STATES in its text (2026-10-08, "October 8, 2026", "8 October 2026"); a publication timestamp is not read. Whole tokens, real days only.
export function statedDays(text: string): string[] {
  const out = new Set<string>(), t = text.toLowerCase(), pad = (n: number) => String(n).padStart(2, '0')
  for (const m of t.matchAll(/(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`)
  const mon = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
  const idx = (s: string) => MONTHS.indexOf(s.slice(0, 3))
  for (const m of t.matchAll(new RegExp(`(?<![\\w])${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\w])`, 'g'))) out.add(`${m[3]}-${pad(idx(m[1]) + 1)}-${pad(Number(m[2]))}`)
  for (const m of t.matchAll(new RegExp(`(?<![\\w\\d])(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon},?\\s+(\\d{4})(?![\\w])`, 'g'))) out.add(`${m[3]}-${pad(idx(m[2]) + 1)}-${pad(Number(m[1]))}`)
  return [...out].filter(isDay)
}

// ---- clause-level employment binding ----
// A sentence counts only when it asserts an employment RELATIONSHIP between this person and this company: the person must be the subject of the predicate and the company its
// direct object (at/with/for/from/of), with nothing in between that changes who or what is meant. Anything else (a lawsuit, a negation, "replaced X, who left", a talk or an
// investment) is NOT evidence either way: unknown. A departure cue ANYWHERE in a sentence naming the person and the company blocks "current" from that sentence: it is either a
// bound departure (former) or too ambiguous to call current (unknown), never current.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NOT_BETWEEN = /\b(not|never|neither|nor|n t|isn t|wasn t|aren t|doesn t|didn t|suing|sued|sue|against|replac\w*|succeed\w*|who|whom|whose|after|before|than|while|but|which|that|if|whether|rumou?r\w*|allegedly)\b/
// a departure may be introduced by an appositive ("Jane Doe, who left X"), so these relative words are allowed between the name and a DEPARTURE only
const NOT_BETWEEN_FORMER = /\b(not|never|neither|nor|n t|isn t|wasn t|aren t|doesn t|didn t|suing|sued|sue|against|replac\w*|succeed\w*|after|before|than|while|but|if|whether|rumou?r\w*|allegedly)\b/
const DEPART_CUE = /\b(former|formerly|ex|previously|left|leaves|leaving|departed|departs|quit|exited|resigned|resigns|stepped down|steps down|retired|no longer|alumn\w+|moved on|parted ways|until \d{4}|laid off|fired|dismissed|terminated)\b/
// present-tense "is X at/with Company" that is not employment: a talk, an investment, an advisory seat, a customer relationship
const NON_EMPLOYMENT = /\b(speak\w*|keynote\w*|panel\w*|guest|attend\w*|visit\w*|invest\w*|advis\w*|board member|director of the board|customer|client|vendor|supplier|partner\w*|sponsor\w*|donor|shareholder|stockholder|competitor|interview\w*|applicant|candidate|applying|applied|mentor\w*|student|fan|user of)\b/
const EVENT_NOUN = /^\s*(summit|conference|event|webinar|podcast|meetup|awards?|fund|ventures|capital|foundation|day|week|panel|keynote|forum|expo|hackathon|conf)\b/
const ORG = '(?:at|with|for|from|of)'
const NOT_ORG = '(?:(?!(?:at|with|for|from)\\b)\\w+\\s+)'
const formerPatterns = (c: string) => [
  new RegExp(`\\b(?:former|formerly|ex|previously)\\s+${NOT_ORG}{0,6}${ORG}\\s+${c}\\b`),
  new RegExp(`\\b(?:left|leaves|departed|departs|quit|exited|resigned from|stepped down from|retired from|moved on from|parted ways with)(?:\\s+from)?\\s+${c}\\b`),
  new RegExp(`\\b(?:resigned|stepped down|retired)\\s+${NOT_ORG}{0,4}(?:from|at)\\s+${c}\\b`),
  new RegExp(`\\bno longer\\s+(?:works|is|employed|serves|with|at|for|by)\\b\\s*${NOT_ORG}{0,4}(?:(?:at|with|for|by)\\s+)?${c}\\b`),
  new RegExp(`\\b${c}\\s+alumn\\w+\\b|\\balumn\\w+\\s+of\\s+${c}\\b`),
  new RegExp(`\\b(?:was|worked|served)\\s+${NOT_ORG}{0,6}(?:at|with|for)\\s+${c}\\s+until\\s+\\d{4}\\b`),
]
const currentPatterns = (c: string) => [
  new RegExp(`^\\s*(?:is|joined|has joined|joins|serves as|works as|works|currently|now|was named|was appointed|appointed|named|promoted to)\\b\\s*${NOT_ORG}{0,8}(?:at|with|for)\\s+${c}\\b`),
]
type Kind = 'former' | 'current' | null
function classify(sentence: string, p: PersonClaim): Kind {
  const text = ` ${norm(sentence)} `, who = ` ${norm(p.name)} `, at = text.indexOf(who)
  if (at < 0) return null
  const after = text.slice(at + who.length), c = esc(norm(p.company)).replace(/\s+/g, '\\s+')
  const first = (pats: RegExp[]) => { for (const re of pats) { const m = re.exec(after); if (m) return { start: m.index, end: m.index + m[0].length } } return null }
  const f = first(formerPatterns(c))
  if (f) { const pre = after.slice(0, f.start); return pre.trim().split(/\s+/).filter(Boolean).length > 10 || NOT_BETWEEN_FORMER.test(pre) ? null : 'former' }
  const cur = first(currentPatterns(c))
  if (!cur) return null
  const pre = after.slice(0, cur.start), span = after.slice(cur.start, cur.end), rest = after.slice(cur.end)
  if (DEPART_CUE.test(text) || NON_EMPLOYMENT.test(span) || NON_EMPLOYMENT.test(pre) || EVENT_NOUN.test(rest)) return null
  if (pre.trim().split(/\s+/).filter(Boolean).length > 8 || NOT_BETWEEN.test(pre) || NOT_BETWEEN.test(span)) return null
  return 'current'
}

// A date counts for an employment sentence only when it is bound to it: stated in that very sentence, or the page's OWN label: a sentence that BEGINS with posted / published /
// updated / last updated / dated / as of / reviewed and is followed at once by a date. "We updated our cookie policy on 2026-11-01" is not a page label, and neither is a date
// elsewhere on the page (a webinar, a related-news item).
const LABEL = /(?:^|[.!?]\s+|\n)[\s*_>#-]*(?:posted|published|updated|last updated|dated|as of|reviewed)\s*(?:on|:)?\s*(.{0,30})/gim
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2}|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\.?,?\s+\d{4})/i
const labelledDays = (text: string) => [...text.matchAll(LABEL)].flatMap(m => { const d = LEADING_DATE.exec(m[1]); return d ? statedDays(d[1]) : [] })
const sentencesOf = (text: string, p: PersonClaim) => text.split(/(?<=[.!?])\s+|\n+/).filter(x => has(x, p.name) && has(x, p.company))

const isPage = (x: unknown): x is PersonPage => typeof x === 'object' && x !== null && typeof (x as PersonPage).url === 'string' && typeof (x as PersonPage).text === 'string'
const unknownResult = (why: string): PersonResult => ({ person: 'unknown', title_matches: 'unknown', reason: why, evidence: [] })

// Malformed input fails closed: a non-array `pages`, a null or wrong-type page, a non-string name/company, or an as_of that is not a real day is unknown, never a throw.
export function verifyPerson(p: PersonClaim, rawPages: PersonPage[], o: PersonOptions): PersonResult {
  if (!p || typeof p.name !== 'string' || typeof p.company !== 'string' || !o || !isDay(o.as_of)) return unknownResult('the claim or the as_of day is malformed, so nothing can be confirmed')
  const pages = Array.isArray(rawPages) ? rawPages.filter(isPage) : []
  const max = typeof o.max_age_days === 'number' && Number.isFinite(o.max_age_days) && o.max_age_days >= 0 ? o.max_age_days : 365
  const inWindow = (days: string[]) => days.some(d => { const age = day(o.as_of) - day(d); return age >= 0 && age <= max })
  let current: { url: string; sentence: string } | null = null
  for (const pg of pages) {
    const page = labelledDays(pg.text)
    for (const sentence of sentencesOf(pg.text, p)) {
      const kind = classify(sentence, p)
      if (!kind || !inWindow([...statedDays(sentence), ...page])) continue
      if (kind === 'former') return { person: 'former', title_matches: 'unknown', reason: `a page dated within ${max} days says ${p.name} has left ${p.company}`, evidence: [pg.url] }
      if (!current) current = { url: pg.url, sentence }
    }
  }
  if (!current) return unknownResult(`no dated page within ${max} days states that ${p.name} is at ${p.company}`)
  return { person: 'current', title_matches: p.title && has(current.sentence, p.title) ? 'pass' : 'unknown', reason: `a page dated within ${max} days says ${p.name} is at ${p.company}`, evidence: [current.url] }
}

// The LeadEvidence.contact the contract reads: the route, what the independent check found about the person, and WHICH person (so the contract can tie the address to them).
export const contactEvidence = (email: string | null | undefined, phone: string | null | undefined, r: PersonResult, name?: string | null) =>
  ({ email: email ?? null, phone: phone ?? null, person: r.person, person_name: name ?? null })
