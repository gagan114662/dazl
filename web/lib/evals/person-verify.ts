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
//  - A departure cue ANYWHERE in a sentence naming the person and the company (before the name, company first, "ex-", "outgoing", "used to", "was ... from 2019 to 2024", "joined
//    Rival from <company>"), or "has left the company" on a page naming it, blocks current from EVERY page unless that sentence is clearly older than the window: unknown at best.
//  - The sentence's own stated day wins over the page label; the label dates only a sentence that states no day.
//  - Inverted (#1030 round 2): current is confirmed only if EVERY in-window or undated sentence naming the person and the company itself reads as current; any other one,
//    cued or not, makes the result unknown unless a bound former is found. "Is <X> at" needs X to open a role (article, possessive, title word, or "now at").
//  - Not employment: a present participle ("is presenting at"), "works with", a consultant/contractor/freelancer/agency, an event ("<company> Live").
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
// Matched on norm()'d text (lower case, punctuation folded to spaces: "ex-Northwind" is "ex northwind", "Labs’" is "labs"). A deterministic list, so it only ever BLOCKS
// current (unknown at best); it never promotes anybody, and a bound former still needs the patterns below.
const DEPART_CUE = new RegExp('\\b(' + [
  'former', 'formerly', 'ex', 'previously', 'prior', 'left', 'leaves', 'leaving', 'departed', 'departs', 'departing', 'departure', 'quit', 'quits', 'quitting',
  'exited', 'exits', 'exiting', 'resigned', 'resigns', 'resigning', 'resignation', 'step(?:s|ped|ping)? (?:down|away|aside)', 'retired', 'retires', 'retiring', 'retirement',
  'no longer', 'alumn\\w+', 'moved on', 'parted ways', '(?:until|through|till) (?:19|20)\\d{2}', '(?:19|20)\\d{2} (?:to |until |through |and )?(?:19|20)\\d{2}',
  'laid off', 'let go', 'fired', 'dismissed', 'terminated', 'outgoing', 'used to', 'spent', 'after (?:\\w+ ){0,2}(?:years?|months?|decades?)', 'before (?:joining|moving|leaving|heading|starting)',
  'successor', 'farewell', '(?<!has |have )worked', '(?<!has |have )served',
  '(?:was|were|had been)(?! (?:named|appointed|promoted|hired|elected|recently|just|newly|tapped|selected|chosen))',
].join('|') + ')\\b')
// "joined Rival from Northwind Labs", "moved from Northwind Labs to Rival": a move AWAY from the company (company-aware, so it is checked per claim). c is the escaped company.
const MOVE_VERB = /\b(join\w*|mov(?:e|es|ed|ing)|came|comes|coming|arriv\w+|hired|poached|recruited|switch\w*)\b/
const hasMovedFrom = (text: string, c: string) => new RegExp(`\\bfrom\\s+${c}\\s+to\\b`).test(text) || (MOVE_VERB.test(text) && new RegExp(`\\bfrom\\s+${c}\\b`).test(text))
const departs = (sentence: string, c: string) => { const t = ` ${norm(sentence)} `; return DEPART_CUE.test(t) || hasMovedFrom(t, c) }
// present-tense "is X at/with Company" that is not employment: a talk, an investment, an advisory seat, a customer relationship
// Decision (Hermes, under delegation): a consultant, contractor, freelancer or agency is NOT an employee for #781 (they may not be there next month and are rarely the buyer).
const NON_EMPLOYMENT = /\b(consult\w*|contractor\w*|freelanc\w*|subcontract\w*|outsourc\w*|agency|speak\w*|keynote\w*|panel\w*|guest|attend\w*|visit\w*|invest\w*|advis\w*|board member|director of the board|customer|client|vendor|supplier|partner\w*|sponsor\w*|donor|shareholder|stockholder|competitor|interview\w*|applicant|candidate|applying|applied|mentor\w*|student|fan|user of)\b/
const EVENT_NOUN = /^\s*(summit|conference|event|webinar|podcast|meetup|awards?|fund|ventures|capital|foundation|day|week|panel|keynote|forum|expo|hackathon|conf|live|connect|world|symposium|roadshow|tour|show|talks?|session|workshop|festival|fair|demo day)\b/
// The predicate is a present participle ("is presenting at", "is now hosting"): an activity, not a job. A title ending in -ing (VP of Engineering) never sits in this slot,
// because the slot is the word right after is/now/currently.
const PARTICIPLE = /^\s*(?:is|now|currently)\s+(?:(?:currently|now|also|still|actively|busy)\s+)*\w{2,}ing\b/
// "works with" names a partner, not an employer ("is the founder of Rival and works with Northwind Labs").
const WORKS_WITH = /\bwork(?:s|ing)?\s+with\b/
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
  // "joined Northwind Labs as VP of Sales": the company as the direct object of a join, followed by the role it was joined as
  new RegExp(`^\\s*(?:joined|has joined|joins|rejoined|has rejoined)\\s+${c}\\s+as\\b`),
]
// "is <X> at Company" is employment only when X opens a role: an article or possessive, a title word, or "now at". Anything else ("is out at", "is done at",
// "is through with") is not a statement of employment: unknown, and it then blocks current like any other non-current sentence about the pair (verifyPerson).
const IS_HEAD = /^\s*(?:is|currently|now)\b(?:\s+(?:is|currently|now|also|still|presently))*\s+(\S+)/   // \S+, not \w+: a non-ASCII first word ("überchef") must be checked too, never skipped
const ROLE_OPENER = new Set(['a', 'an', 'the', 'our', 'their', 'its', 'his', 'her', 'one', 'employed', 'head', 'chief', 'ceo', 'cto', 'cfo', 'coo', 'cmo', 'cro', 'cio', 'ciso', 'cpo',
  'vp', 'svp', 'evp', 'avp', 'vice', 'president', 'director', 'manager', 'lead', 'leader', 'founder', 'cofounder', 'co', 'owner', 'principal', 'engineer', 'officer', 'executive',
  'gm', 'general', 'senior', 'sr', 'junior', 'jr', 'staff', 'associate', 'assistant', 'dentist', 'doctor', 'dr', 'physician', 'hygienist', 'office', 'practice', 'account',
  'sales', 'marketing', 'product', 'business', 'regional', 'global', 'national', 'group', 'managing', 'chair', 'chairman', 'chairwoman', 'chairperson', 'secretary',
  'treasurer', 'controller', 'analyst', 'specialist', 'coordinator', 'administrator', 'recruiter', 'developer', 'designer', 'architect', 'scientist', 'researcher', 'counsel',
  'attorney', 'lawyer', 'nurse', 'therapist', 'editor', 'producer', 'operations', 'finance', 'hr', 'people', 'talent', 'revenue', 'growth', 'engineering', 'technical', 'interim',
  // "currently leads sales at", "now heads marketing at": a verb that itself states the role
  'leads', 'heads', 'runs', 'manages', 'oversees', 'directs', 'works', 'serves', 'handles', 'owns'])
const roleOpens = (span: string) => {
  const m = IS_HEAD.exec(span)
  if (!m) return true   // joined / serves as / works as / named / appointed / promoted to: the verb itself states the role
  if (m[1] === 'at' || m[1] === 'with' || m[1] === 'for') return /\bnow\b/.test(m[0])   // "is now at X" is a move-in; a bare "is at X" (a visit, a demo) is not
  return ROLE_OPENER.has(m[1])
}
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
  if (DEPART_CUE.test(text) || hasMovedFrom(text, c) || NON_EMPLOYMENT.test(span) || NON_EMPLOYMENT.test(pre) || EVENT_NOUN.test(rest) || PARTICIPLE.test(span) || WORKS_WITH.test(span)) return null
  if (!roleOpens(span) || (/\bas\s*$/.test(span) && NON_EMPLOYMENT.test(rest.slice(0, 80)))) return null
  if (pre.trim().split(/\s+/).filter(Boolean).length > 8 || NOT_BETWEEN.test(pre) || NOT_BETWEEN.test(span)) return null
  return 'current'
}

// A date counts for an employment sentence only when it is bound to it: stated in that very sentence, or the page's OWN label: a sentence that BEGINS with posted / published /
// updated / last updated / dated / as of / reviewed and is followed at once by a date. "We updated our cookie policy on 2026-11-01" is not a page label, and neither is a date
// elsewhere on the page (a webinar, a related-news item).
const LABEL = /(?:^|[.!?]\s+|\n)[\s*_>#-]*(?:posted|published|updated|last updated|dated|as of|reviewed)\s*(?:on|:)?\s*(.{0,30})/gim
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2}|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\.?,?\s+\d{4})/i
const labelledDays = (text: string) => [...text.matchAll(LABEL)].flatMap(m => { const d = LEADING_DATE.exec(m[1]); return d ? statedDays(d[1]) : [] })
// Sentences, but never split after an abbreviation ("Oct. 20, 2026", "Dr. Doe", "Rival Inc. hired"): splitting there cut a departure away from its own date.
const ABBREV = /(?<![\p{L}\p{N}])(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|mr|mrs|ms|dr|prof|st|jr|sr|inc|co|corp|ltd|llc|vs|no|vp|svp|evp|approx|dept|est)\.$/iu
const splitSentences = (text: string) => {
  const out: string[] = []; let buf = ''
  for (const part of text.split(/(?<=[.!?])\s+|\n+/)) { buf = buf ? `${buf} ${part}` : part; if (!ABBREV.test(part.slice(-12))) { out.push(buf); buf = '' } }   // test the new part's tail only: linear, even on "Inc. Inc. Inc. ..."
  if (buf) out.push(buf)
  return out
}
const sentencesOf = (text: string, p: PersonClaim) => splitSentences(text).filter(x => has(x, p.name) && has(x, p.company))
// A departure that says "the company" instead of its name ("Jane Doe has left the company."), on a page that names the company.
const THE_COMPANY = /\bthe (?:company|firm|business|organi[sz]ation|team|startup|practice|agency|group)\b/
const sentencesAboutPerson = (text: string, p: PersonClaim) => has(text, p.company) ? splitSentences(text).filter(x => has(x, p.name) && !has(x, p.company) && THE_COMPANY.test(norm(x))) : []

const isPage = (x: unknown): x is PersonPage => typeof x === 'object' && x !== null && typeof (x as PersonPage).url === 'string' && typeof (x as PersonPage).text === 'string'
const unknownResult = (why: string): PersonResult => ({ person: 'unknown', title_matches: 'unknown', reason: why, evidence: [] })

// Malformed input fails closed: a non-array `pages`, a null or wrong-type page, a non-string name/company, or an as_of that is not a real day is unknown, never a throw.
export function verifyPerson(p: PersonClaim, rawPages: PersonPage[], o: PersonOptions): PersonResult {
  if (!p || typeof p.name !== 'string' || typeof p.company !== 'string' || !o || !isDay(o.as_of)) return unknownResult('the claim or the as_of day is malformed, so nothing can be confirmed')
  const pages = Array.isArray(rawPages) ? rawPages.filter(isPage) : []
  // A max_age_days that is present but not a finite number >= 0 (a string, NaN, -1) is malformed: unknown, never silently widened to the 365-day default.
  if (o.max_age_days !== undefined && o.max_age_days !== null && !(typeof o.max_age_days === 'number' && Number.isFinite(o.max_age_days) && o.max_age_days >= 0)) return unknownResult('max_age_days is malformed, so freshness cannot be judged')
  const max = typeof o.max_age_days === 'number' ? o.max_age_days : 365
  const inWindow = (days: string[]) => days.some(d => { const age = day(o.as_of) - day(d); return age >= 0 && age <= max })
  // Only a day clearly OLDER than the window lets a departure cue be ignored (a rehire is possible): an undated, fresh or future-dated departure blocks current.
  const notStale = (days: string[]) => days.length === 0 || days.some(d => day(o.as_of) - day(d) <= max)
  // The sentence's own stated day wins; the page label dates only a sentence that states none ("Posted <fresh>. In <2019> filings, ..." is 2019).
  const boundDays = (sentence: string, page: string[]) => { const own = statedDays(sentence); return own.length ? own : page }
  const c = esc(norm(p.company)).replace(/\s+/g, '\\s+')
  let current: { url: string; sentence: string } | null = null, blocked: string | null = null
  for (const pg of pages) {
    const page = labelledDays(pg.text)
    for (const sentence of sentencesOf(pg.text, p)) {
      const days = boundDays(sentence, page), kind = classify(sentence, p)
      // Inverted rule (#1030 round 2): a cue list can never be exhaustive, so ANY in-window or undated sentence naming the pair that does not itself read as current
      // (departure wording nobody listed, "tenure ended", "says goodbye to", "is out at") blocks current. A bound former in the window still wins below.
      if (blocked === null && kind !== 'current' && notStale(days)) blocked = pg.url
      if (blocked === null && departs(sentence, c) && notStale(days)) blocked = pg.url
      if (!kind || !inWindow(days)) continue
      if (kind === 'former') return { person: 'former', title_matches: 'unknown', reason: `a page dated within ${max} days says ${p.name} has left ${p.company}`, evidence: [pg.url] }
      if (!current) current = { url: pg.url, sentence }
    }
    // A sentence about the person that says "the company" (on a page naming it) never reads as current by itself, so under the same inverted rule any fresh or undated one blocks.
    for (const sentence of sentencesAboutPerson(pg.text, p)) if (blocked === null && notStale(boundDays(sentence, page))) blocked = pg.url
  }
  if (!current) return unknownResult(`no dated page within ${max} days states that ${p.name} is at ${p.company}`)
  if (blocked !== null) return { person: 'unknown', title_matches: 'unknown', reason: `a page says ${p.name} is at ${p.company}, but another fresh or undated sentence about them there does not read as current employment, so current cannot be confirmed`, evidence: [current.url, blocked] }
  return { person: 'current', title_matches: typeof p.title === 'string' && has(current.sentence, p.title) ? 'pass' : 'unknown', reason: `a page dated within ${max} days says ${p.name} is at ${p.company}`, evidence: [current.url] }
}

// The LeadEvidence.contact the contract reads: the route, what the independent check found about the person, and WHICH person (so the contract can tie the address to them).
// Malformed input fails closed: a missing or malformed result is 'unknown' (a check ran and confirmed nothing), and a non-string email, phone or name is null.
const str = (v: unknown) => typeof v === 'string' ? v : null
export const contactEvidence = (email: string | null | undefined, phone: string | null | undefined, r: PersonResult | null | undefined, name?: string | null) => {
  const person: PersonResult['person'] = r && typeof r === 'object' && (r.person === 'current' || r.person === 'former' || r.person === 'unknown') ? r.person : 'unknown'
  return { email: str(email), phone: str(phone), person, person_name: str(name) }
}
