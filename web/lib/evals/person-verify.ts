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
  for (const m of t.matchAll(new RegExp(`(?<![\\w])${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\d])`, 'g'))) out.add(`${m[3]}-${pad(idx(m[1]) + 1)}-${pad(Number(m[2]))}`)
  for (const m of t.matchAll(new RegExp(`(?<![\\w\\d])(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon},?\\s+(\\d{4})(?![\\d])`, 'g'))) out.add(`${m[3]}-${pad(idx(m[2]) + 1)}-${pad(Number(m[1]))}`)
  return [...out].filter(isDay)
}

// ---- clause-level employment binding ----
// A sentence counts only when it asserts an employment RELATIONSHIP between this person and this company: the person must be the subject of the predicate, the company its
// direct object (via at/with/for/from), with nothing in between that changes who or what is meant. Anything else (a lawsuit, a negation, "replaced X, who left", a former role
// at a different company) is NOT evidence either way: unknown.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NOT_BETWEEN = /\b(not|never|neither|nor|n t|isn t|wasn t|aren t|doesn t|didn t|suing|sued|sue|against|replac\w*|succeed\w*|who|whom|whose|after|before|than|while|but|which|that|if|whether|rumou?r\w*|allegedly)\b/
const ORG = '(?:at|with|for|from)'
const NOT_ORG = '(?:(?!(?:at|with|for|from)\\b)\\w+\\s+)'
const formerPatterns = (c: string) => [
  new RegExp(`\\b(?:former|formerly|ex|previously)\\s+${NOT_ORG}{0,5}${ORG}\\s+${c}\\b`),
  new RegExp(`\\b(?:left|leaves|departed|quit|exited|resigned from|stepped down from|moved on from)\\s+${c}\\b`),
  new RegExp(`\\b(?:resigned|stepped down)\\s+${NOT_ORG}{0,4}(?:from|at)\\s+${c}\\b`),
  new RegExp(`\\bno longer\\s+(?:works|is|employed|serves|with)\\b\\s*${NOT_ORG}{0,4}(?:(?:at|with|for|by)\\s+)?${c}\\b`),
  new RegExp(`\\b${c}\\s+alumn\\w+\\b|\\balumn\\w+\\s+of\\s+${c}\\b`),
  new RegExp(`\\b(?:was|worked|served)\\s+${NOT_ORG}{0,6}(?:at|with|for)\\s+${c}\\s+until\\s+\\d{4}\\b`),
]
const currentPatterns = (c: string) => [
  new RegExp(`^\\s*(?:(?:former|formerly|ex|previously)\\s+${NOT_ORG}{0,5}${ORG}\\s+\\w+(?:\\s+\\w+){0,2}\\s+)?(?:is|joined|has joined|joins|serves as|works as|works|currently|now|was named|was appointed|appointed|named|promoted to)\\b\\s*${NOT_ORG}{0,8}(?:at|with|for)\\s+${c}\\b`),
]
type Kind = 'former' | 'current' | null
function classify(sentence: string, p: PersonClaim): { kind: Kind; between: string } {
  const text = ` ${norm(sentence)} `, who = ` ${norm(p.name)} `, at = text.indexOf(who)
  if (at < 0) return { kind: null, between: '' }
  const after = text.slice(at + who.length), c = esc(norm(p.company)).replace(/\s+/g, '\\s+')
  const tryAll = (pats: RegExp[]) => { for (const re of pats) { const m = re.exec(after); if (m) return { start: m.index, end: m.index + m[0].length } } return null }
  const f = tryAll(formerPatterns(c)), cur = tryAll(currentPatterns(c))
  const hit = f ? { kind: 'former' as const, ...f } : cur ? { kind: 'current' as const, ...cur } : null
  if (!hit) return { kind: null, between: '' }
  const pre = after.slice(0, hit.start), span = after.slice(hit.start, hit.end)
  // the person must be the subject: only a short run of words (a title or an appositive) may sit between the name and the predicate, and none of them may be a connector or a negation
  if (pre.trim().split(/\s+/).filter(Boolean).length > 8 || NOT_BETWEEN.test(pre) || (hit.kind === 'current' && NOT_BETWEEN.test(span))) return { kind: null, between: pre }
  return { kind: hit.kind, between: pre }
}

// A date counts for an employment sentence only when it is bound to it: stated in that very sentence, or labelled as the page's own date (posted, published, updated, dated,
// as of, last updated, reviewed). An unrelated date elsewhere on the page (a webinar, a related-news item) is not the date of the employment statement.
const LABELLED = /\b(?:posted|published|updated|dated|as of|last updated|reviewed)\b\s*(?:on|:)?\s*([^.\n]{0,32})/gi
const labelledDays = (text: string) => [...text.matchAll(LABELLED)].flatMap(m => statedDays(m[1]))
const sentencesOf = (text: string, p: PersonClaim) => text.split(/(?<=[.!?])\s+|\n+/).filter(x => has(x, p.name) && has(x, p.company))

export function verifyPerson(p: PersonClaim, pages: PersonPage[], o: PersonOptions): PersonResult {
  const max = o.max_age_days ?? 365
  const inWindow = (days: string[]) => days.some(d => { const age = day(o.as_of) - day(d); return age >= 0 && age <= max })
  let current: { url: string; sentence: string } | null = null
  for (const pg of pages) {
    const page = labelledDays(pg.text)
    for (const sentence of sentencesOf(pg.text, p)) {
      const { kind } = classify(sentence, p)
      if (!kind || !inWindow([...statedDays(sentence), ...page])) continue
      if (kind === 'former') return { person: 'former', title_matches: 'unknown', reason: `a page dated within ${max} days says ${p.name} has left ${p.company}`, evidence: [pg.url] }
      if (!current) current = { url: pg.url, sentence }
    }
  }
  if (!current) return { person: 'unknown', title_matches: 'unknown', reason: `no dated page within ${max} days states that ${p.name} is at ${p.company}`, evidence: [] }
  return { person: 'current', title_matches: p.title && has(current.sentence, p.title) ? 'pass' : 'unknown', reason: `a page dated within ${max} days says ${p.name} is at ${p.company}`, evidence: [current.url] }
}

// The LeadEvidence.contact the contract reads: the route plus what the independent check found about the person.
export const contactEvidence = (email: string | null | undefined, phone: string | null | undefined, r: PersonResult) => ({ email: email ?? null, phone: phone ?? null, person: r.person })
