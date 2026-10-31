import { isRecruitingInbox } from '../recruiting-inbox.ts'
import type { Page } from './fetch-page.ts'
import { classifySource } from './source-quality.ts'

export interface Candidate {
  name: string
  company: string
  contact: string | null
  signal: string
  source_url: string
  score: number
  excerpt: string
  event_date: string | null
  published_at?: string | null // the page's publication day (label only; never the event date)
  timing_note?: string | null // how the date was read from the page, or a season/"soon" label with no date (scan/page-timing.ts)
}

export type Verdict =
  | { ok: true; confidence: number; contact: string | null; dateStatus: 'verified' | 'unverified' | 'undated'; retrievedAt: number; passage: string }
  | { ok: false; reason: string }

export const MAX_AGE_DAYS = Number(process.env.SCAN_MAX_AGE_DAYS || 365)
export const MIN_CONFIDENCE = 55

// Letters, their combining marks and digits of ANY script are kept (Devanagari, Arabic, Han, kana, Cyrillic, Greek ... as well as Latin with its accents folded). Before, everything outside a-z was erased, so a Hindi,
// Arabic or Japanese quote normalized to "" and was dropped as no_excerpt: a business that does not write in Latin script could never be verified.
export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{M}\p{N}@.+ ]+/gu, ' ').replace(/\s+/g, ' ').trim()

const SUFFIXES = new Set(['inc', 'incorporated', 'ltd', 'limited', 'llc', 'corp', 'corporation', 'co', 'company', 'the', 'plc', 'llp', 'lp'])
export function companyKey(company: string): string {
  const words = norm(company).replace(/[.@+]/g, ' ').split(' ').filter(w => w && !SUFFIXES.has(w))
  return words.join(' ')
}

// Scripts written without spaces between words (Han, kana, Thai ...): a phrase there cannot be word-bounded by spaces, so it is a plain substring match.
const UNSPACED = /[\u0e00-\u0eff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/
export const hasPhrase = (hay: string, phrase: string) => !!phrase && (UNSPACED.test(phrase) ? hay.includes(phrase) : new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(hay))

// The extraction contract demands a verbatim quote; models paraphrase anyway, and the strict
// verifier then rejects real signals (excerpt_not_on_page). Where the pipeline already holds the
// fetched source text, this extractor may attach a VERBATIM window - but only for a claim that
// parses a NARROW AFFIRMATIVE grammar and whose window binds the company as the hiring subject.
// Two adversarial rounds killed the wider versions; the rule is now affirmative, not a denylist:
// any clause, modal, negation, gloss or tense outside the grammar routes to review, and no
// amount of extra phrase exclusions is attempted.
//   grammar  - the claim must be exactly "<company> is/are [currently/actively] hiring <object>"
//              where every object token is a role word, a count, or a closed connector set.
//              Negation, modals, future/past tense, extra clauses and gloss markers all fail
//              this by construction - no denylist to slip past.
//   role     - at least one concrete role named in the claim; every named role must appear
//              in the window (distinct listing segments; a repeated identical posting is one).
//   quantity - an explicit count tied to a role equals the number of DISTINCT segments naming it.
//   entity   - the company is named in the window or within +/-300 chars of it.
//   subject  - no role segment may carry a hiring/join subject clause naming a DIFFERENT
//              capitalized entity ("Acme rival Rival Robotics is hiring" attaches nothing).
//   window   - closed/filled/not-hiring markers and boilerplate-dominated windows reject.
// Any unresolved facet -> null -> the unchanged honest needs_review path, original text
// preserved. The verifier is untouched and re-checks any attached window against its own
// live fetch. The claim text is never rewritten.
const ROLE_LEXICON = [
  'account executive', 'chief of staff', 'sales development representative', 'business development representative',
  'account manager', 'customer success manager', 'sales manager', 'sales operations manager', 'crm administrator',
  'revenue operations', 'head of sales', 'vp of sales', 'director of sales', 'sales director', 'growth manager',
  'product manager', 'engineering manager', 'solutions engineer', 'forward deployed engineer', 'machine learning engineer',
  'full stack engineer', 'software engineer', 'data scientist', 'data engineer', 'designer', 'developer',
  'recruiter', 'operations manager', 'marketing manager', 'gtm intern', 'intern', 'analyst', 'engineer',
]
const CLOSED_OR_NEGATED = /\b(?:no longer accepting applications|this (?:job|position|role) is no longer (?:available|open)|this (?:job|position|role) has (?:closed|expired|been filled)|applications for this (?:job|position|role) are closed|not currently hiring|is not hiring|isn't hiring|are not hiring|aren't hiring|no longer hiring|not planning to hire|no plans to hire|hiring freeze)\b/i
const BOILER = new Set(['careers', 'jobs', 'apply', 'home', 'about', 'contact', 'menu', 'search', 'login', 'sign', 'copyright', 'privacy', 'terms', 'cookie', 'cookies', 'subscribe', 'follow', 'share', 'blog', 'press'])
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const CONNECTOR = new Set([
  'a', 'an', 'and', 'or', 'for', 'in', 'of', 'the', 'its', 'their', 'our', 'to', 'across', 'with', 'plus', 'including',
  'new', 'role', 'roles', 'position', 'positions', 'opening', 'openings', 'team', 'teams', 'vacancy', 'vacancies',
  'remote', 'hybrid', 'onsite', 'full', 'time', 'part', 'contract', 'based', 'go', 'market', 'gtm',
  'multiple', 'several', 'founding', 'senior', 'junior', 'staff', 'principal', 'lead', 'head', 'vp', 'director', 'chief',
])
const ALLOWED = new Set([...CONNECTOR, ...ROLE_LEXICON.flatMap(r => r.split(' ')), ...Object.keys(NUM_WORDS)])

const rolePattern = (role: string) => new RegExp(`\\b${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'g')
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The whole claim must parse as one affirmative present-tense hiring assertion. Anything
// extra - a second clause, a modal, a gloss, a time shift - fails closed to review.
function claimGrammarOk(claimText: string, key: string): boolean {
  const m = norm(claimText).match(new RegExp(`^${escapeRe(key)} (?:is|are) (?:currently |actively )?hiring\\b(.*)$`))
  if (!m) return false
  const rest = m[1].trim().split(' ').filter(Boolean)
  if (rest.length === 0) return false
  // norm keeps '.', so strip trailing sentence punctuation before the whitelist check.
  return rest.every(t => { const w = t.replace(/\.+$/, ''); return ALLOWED.has(w) || /^\d+$/.test(w) || (w.endsWith('s') && ALLOWED.has(w.slice(0, -1))) })
}

function claimFacets(claimText: string) {
  const concrete = norm(claimText)
  const roles: { role: string; want: number | null }[] = []
  for (const role of ROLE_LEXICON) {
    const re = rolePattern(role)
    if (!re.test(concrete)) continue
    re.lastIndex = 0
    const at = concrete.search(re)
    const before = concrete.slice(Math.max(0, at - 24), at).trim().split(' ')
    let want: number | null = null
    for (let i = before.length - 1; i >= 0 && i >= before.length - 3; i--) {
      const t = before[i]
      if (/^\d+$/.test(t)) { want = Number(t); break }
      if (NUM_WORDS[t] !== undefined && !(t === 'a' && i > 0 && before[i - 1] === 'of')) { want = NUM_WORDS[t]; break }
      if (['and', 'including', 'for', 'in', 'of', 'founding', 'senior', 'junior', 'staff', 'principal', 'lead', 'new', 'multiple'].includes(t)) continue
      break
    }
    roles.push({ role, want })
  }
  const multi = /\b(?:multiple|several)\b.{0,40}\b(?:role|position|opening|hire)s?\b/.test(concrete)
  // Sub-role dedupe: 'engineer' inside 'software engineer' is one mention, not two.
  const deduped = roles.filter(({ role }) => !roles.some(({ role: other }) => other !== role && other.includes(role)))
  return { roles: deduped, multi }
}

// A hiring/join clause whose subject is not the company. The subject of "X is hiring ..." is the WHOLE clause before the verb (back to the segment
// start or the last delimiter), in ANY case: "rival acme is hiring" and "RIVAL ROBOTICS is hiring" are not Acme, so a longer foreign name that merely
// ENDS in the claimed name cannot pass. Only leading filler ("now", "and", "today") is dropped. A pronoun "we/our/us" ending the clause is the
// first-party voice and binds the page owner. "Join <name> ..." binds the complete name up to a stop word or punctuation, case-blind; a determiner
// or pronoun after "join" ("join our team", "join the team") names no employer, so it is not foreign.
const HIRING_CLAUSE = /\b(?:is|are|was|were|has been|will be)\s+(?:currently |actively |now )?(?:hiring|recruiting|looking to hire)\b/gi
const JOIN_CLAUSE = /\bjoin(?:ing)?\s+([^,.;:!?()\u2013\u2014]{1,60})/gi
const LEAD_FILLER = new Set(['and', 'but', 'also', 'now', 'today', 'still', 'currently', 'yes'])
const JOIN_NON_NAME = new Set(['we', 'our', 'us', 'the', 'a', 'an', 'my', 'your', 'their', 'this', 'that', 'these', 'those', 'one', 'it', 'its', 'team', 'teams'])
const JOIN_STOP = new Set(['as', 'for', 'in', 'at', 'to', 'on', 'and', 'or', 'with', 'today', 'now', 'when', 'where', 'if', 'so', 'us', 'our', 'the', 'a', 'an'])
function foreignSubject(rawSegment: string, key: string): boolean {
  HIRING_CLAUSE.lastIndex = 0
  let h: RegExpExecArray | null
  while ((h = HIRING_CLAUSE.exec(rawSegment))) {
    const clause = rawSegment.slice(0, h.index).replace(/,\s*(Inc|Ltd|LLC|Corp|Co|Plc)\b/gi, ' $1').split(/[,;:()]|\s[-\u2013\u2014]\s/).pop() ?? ''
    const ws = clause.split(/\s+/).filter(Boolean)
    if (ws.length > 0 && ['we', 'our', 'us'].includes(ws[ws.length - 1].toLowerCase())) continue
    while (ws.length > 0 && LEAD_FILLER.has(ws[0].toLowerCase())) ws.shift()
    if (ws.length === 0 || ws.length > 6) return true            // no subject, or too long to be a name: cannot be bound to the company, fail closed
    if (companyKey(ws.join(' ')) !== key) return true
  }
  JOIN_CLAUSE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = JOIN_CLAUSE.exec(rawSegment))) {
    const ws = m[1].trim().split(/\s+/).filter(Boolean)
    if (ws.length === 0 || JOIN_NON_NAME.has(ws[0].toLowerCase())) continue
    const name: string[] = []
    for (const w of ws) { if (JOIN_STOP.has(w.toLowerCase())) break; name.push(w) }
    if (name.length === 0 || name.length > 5 || companyKey(name.join(' ')) !== key) return true
  }
  return false
}

const SEG_SPLIT = /(?<=[.!?])(?<!\b(?:Inc|Ltd|Corp|Co|LLC|Plc)\.)\s+|\s+[\u00b7\u2022|]\s+|\s+-\s+/

function windowSupports(win: string, pageText: string, company: string, facets: ReturnType<typeof claimFacets>): boolean {
  const w = norm(win)
  if (w.length < 20 || CLOSED_OR_NEGATED.test(win)) return false
  const key = companyKey(company)
  if (key.length < 2) return false
  {
    const src = norm(pageText)
    const at = src.indexOf(w)
    if (at < 0) return false
    const near = src.slice(Math.max(0, at - 300), at + w.length + 300)
    if (!hasPhrase(w, key) && !hasPhrase(near, key)) return false
  }
  const wtoks = w.split(' ')
  const boiler = wtoks.filter(t => BOILER.has(t)).length
  if (wtoks.length > 0 && boiler / wtoks.length > 0.4) return false
  // Count DISTINCT listing segments naming the role: a repeated identical posting is one
  // opening, not two. Any segment binding a foreign hiring subject rejects the window.
  const rawSegs = win.split(SEG_SPLIT).map(t => t.trim()).filter(t => norm(t).length >= 8)
  const segNorms = [...new Set(rawSegs.map(t => norm(t)))]
  for (const { role, want } of facets.roles) {
    const re = rolePattern(role)
    const containing = rawSegs.filter(seg => { re.lastIndex = 0; return re.test(norm(seg)) })
    const distinct = new Set(containing.map(seg => norm(seg))).size
    if (distinct === 0) return false
    if (containing.some(seg => foreignSubject(seg, key))) return false
    if (want !== null && distinct !== want) return false
  }
  if (facets.multi) {
    const distinct = facets.roles.filter(({ role }) => { const re = rolePattern(role); return segNorms.some(seg => { re.lastIndex = 0; return re.test(seg) }) }).length
    if (distinct < 2) return false
  }
  return true
}

// "ohm.ai" belongs to "Ohm"; "acme.com" to "Acme" / "Acme Robotics"; never a lookalike. Bare hostnames only (no scheme, path, port or
// whitespace). The domain label must equal the company name (3+ letters, legal suffixes aside), so a company the domain
// does not name can never borrow the domain's first-party status.
const BARE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
export function companyOwnsDomain(company: string, knownDomain: string | null | undefined): boolean {
  const d = (knownDomain ?? '').toLowerCase().trim().replace(/^www\./, '')
  if (!BARE_HOST.test(d)) return false
  const labels = d.split('.'), label = (labels.length > 2 && /^(co|com|org|net|ac|gov)$/.test(labels[labels.length - 2]) ? labels[labels.length - 3] : labels[labels.length - 2]).replace(/-/g, '')
  const key = companyKey(company).replace(/[^a-z0-9]/g, '')
  // The domain's label IS the company (legal suffixes and spacing aside). A label that merely contains the name ("acme-rival", "myacme", "acme2") is another business.
  return label.length >= 3 && key.length >= 3 && label === key
}


// Returns the shortest verbatim window of the page that supports every material facet of
// the claim, or null. When the model's excerpt is already verbatim, returns null (no-op).
export function supportedEvidenceWindow(claim: { company: string; signal: string; excerpt: string }, page: { text: string; title?: string; url: string }, knownDomain?: string | null): string | null {
  const text = page.text ?? ''
  // Repair only ever attaches the company's OWN page: a paraphrased excerpt is repaired
  // against genuinely first-party text with exact host/entity grounding. Editorial,
  // aggregator and unknown sources stay on the review path even when every other gate
  // would pass - first-party hosting never proves the subject by itself (the subject
  // gate below still applies), but it is a necessary condition for trusting the repair.
  // First-party identity comes only from a domain the caller already knows (classifySource accepts no other basis): without one nothing is repaired.
  if (classifySource(page.url, claim.company, knownDomain) !== 'first_party') return null
  // The domain must be a validated bare host and the company must be the one that domain belongs to: a first-party page of
  // some other company (a partner or customer page on the domain) is not evidence about the claimed employer.
  if (!companyOwnsDomain(claim.company, knownDomain)) return null
  const src = norm(text)
  if (!claim.excerpt || src.length < 20) return null
  if (src.includes(norm(claim.excerpt))) return null
  const key = companyKey(claim.company)
  if (key.length < 2) return null
  // Both the displayed claim and the model's excerpt must parse the affirmative grammar.
  if (!claimGrammarOk(claim.signal, key) || !claimGrammarOk(claim.excerpt, key)) return null
  const facets = claimFacets(`${claim.signal} ${claim.excerpt}`)
  if (facets.roles.length === 0) return null // no concrete role named: nothing to support directly
  // Keep separators in the pieces so a chosen window stays a raw substring of the
  // whitespace-flattened page - verbatim for display, not only after normalization.
  const flat = text.replace(/\s+/g, ' ')
  const pieces = flat.split(/((?<=[.!?])(?<!\b(?:Inc|Ltd|Corp|Co|LLC|Plc)\.)\s+|\s+[\u00b7\u2022|]\s+|\s+-\s+)/)
  const idx: number[] = [] // indices of the content pieces (separators sit between them)
  for (let i = 0; i < pieces.length; i += 2) if (norm(pieces[i]).length >= 8 || i === 0) idx.push(i)
  let best: string | null = null
  for (let a = 0; a < idx.length; a++) {
    let win = ''
    for (let b = a; b < idx.length; b++) {
      win = a === b ? pieces[idx[a]] : win + (pieces[idx[b] - 1] ?? '') + pieces[idx[b]]
      if (win.length > 320) break
      if (norm(win).length >= 8 && windowSupports(win, text, claim.company, facets)) {
        if (best === null || win.length < best.length) best = win
      }
    }
  }
  return best ? best.trim() : null
}

export function dedupKey(c: { company: string; name: string }): string {
  return companyKey(c.company) || norm(c.name)
}

function parseDay(s: string | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d
}

export function verifyEvidence(c: Candidate, page: Page, now = new Date()): Verdict {
  const text = norm(page.text)
  // A leading or trailing ellipsis only marks that the quote was cut short. The words that remain must still
  // appear contiguously on the page. An ellipsis inside the quote (words skipped) still fails, and the saved quote is never rewritten.
  const excerpt = norm(c.excerpt.replace(/^\s*(?:\.{3,}|\u2026)+\s*/, '').replace(/\s*(?:\.{3,}|\u2026)+\s*$/, ''))
  if (excerpt.length < 20 || c.excerpt.length > 400) return { ok: false, reason: 'no_excerpt' }
  const at = text.indexOf(excerpt)
  if (at < 0) return { ok: false, reason: 'excerpt_not_on_page' }

  // The company must be named in the quoted passage itself or in the page title.
  // Mentions elsewhere on the page do not count: that is how a rival's story gets pinned on the wrong company.
  const key = companyKey(c.company)
  if (key.length < 2) return { ok: false, reason: 'no_company' }
  const entityOk = hasPhrase(excerpt, key) || hasPhrase(norm(page.title), key)
  if (!entityOk) return { ok: false, reason: 'entity_mismatch' }

  let confidence = 70
  let dateStatus: 'verified' | 'unverified' | 'undated' = 'undated'
  const day = parseDay(c.event_date)
  if (c.event_date && !day) return { ok: false, reason: 'bad_date' }
  if (day) {
    const ageDays = (now.getTime() - day.getTime()) / 86_400_000
    if (ageDays > MAX_AGE_DAYS) return { ok: false, reason: 'stale' }
    if (ageDays < -1) return { ok: false, reason: 'future_date' }
    // A nearby year or publication day does not bind this claimed event to a day.
    dateStatus = 'unverified'
    confidence -= 15
  } else {
    confidence -= 15
  }

  // Contacts survive only if they literally appear on the page.
  let contact: string | null = null
  if (c.contact) {
    const raw = c.contact.trim()
    const digits = raw.replace(/\D/g, '')
    const onPage = raw.includes('@') ? text.includes(raw.toLowerCase()) : digits.length >= 7 && page.text.replace(/\D/g, '').includes(digits)
    // An advertised hiring mailbox is not a sales route. Its publication still corroborates the source,
    // so do not lower event confidence or drop a genuine event just because the contact is unsuitable.
    if (onPage) { contact = isRecruitingInbox(raw) ? null : raw; confidence += 10 }
  }
  confidence = Math.max(0, Math.min(100, confidence))
  if (confidence < MIN_CONFIDENCE) return { ok: false, reason: 'low_confidence' }
  const passage = text.slice(Math.max(0, at - 800), at + excerpt.length + 800)
  return { ok: true, confidence, contact, dateStatus, retrievedAt: page.retrievedAt, passage }
}
