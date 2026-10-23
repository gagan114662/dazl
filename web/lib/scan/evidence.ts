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
}

export type Verdict =
  | { ok: true; confidence: number; contact: string | null; dateStatus: 'verified' | 'unverified' | 'undated'; retrievedAt: number; passage: string }
  | { ok: false; reason: string }

export const MAX_AGE_DAYS = Number(process.env.SCAN_MAX_AGE_DAYS || 365)
export const MIN_CONFIDENCE = 55

export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9@.+ ]+/g, ' ').replace(/\s+/g, ' ').trim()

const SUFFIXES = new Set(['inc', 'incorporated', 'ltd', 'limited', 'llc', 'corp', 'corporation', 'co', 'company', 'the', 'plc', 'llp', 'lp'])
export function companyKey(company: string): string {
  const words = norm(company).replace(/[.@+]/g, ' ').split(' ').filter(w => w && !SUFFIXES.has(w))
  return words.join(' ')
}

export const hasPhrase = (hay: string, phrase: string) => !!phrase && new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(hay)

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

// A hiring/join clause whose capitalized subject is not the company. Pronoun "we/our" is the
// first-party voice and binds the page owner, so it is not flagged foreign.
const SUBJECT_CLAUSE = /([A-Z][A-Za-z0-9&.'-]*(?: [A-Z][A-Za-z0-9&.'-]*){0,3}) (?:is|are|was|were|has been|will be) (?:currently |actively |now )?(?:hiring|recruiting|looking to hire)/g
const JOIN_CLAUSE = /[Jj]oin(?:ing)? ([A-Z][A-Za-z0-9&.'-]*(?: [A-Z][A-Za-z0-9&.'-]*){0,3})/g
function foreignSubject(rawSegment: string, key: string): boolean {
  for (const re of [SUBJECT_CLAUSE, JOIN_CLAUSE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(rawSegment))) {
      const subj = norm(m[1])
      if (['we', 'our', 'us'].includes(subj)) continue
      if (!subj.startsWith(key) && !key.startsWith(subj)) return true
    }
  }
  return false
}

const SEG_SPLIT = /(?<=[.!?])\s+|\s+[\u00b7\u2022|]\s+|\s+-\s+/

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

// Returns the shortest verbatim window of the page that supports every material facet of
// the claim, or null. When the model's excerpt is already verbatim, returns null (no-op).
export function supportedEvidenceWindow(claim: { company: string; signal: string; excerpt: string }, page: { text: string; title?: string; url: string }): string | null {
  const text = page.text ?? ''
  // Repair only ever attaches the company's OWN page: a paraphrased excerpt is repaired
  // against genuinely first-party text with exact host/entity grounding. Editorial,
  // aggregator and unknown sources stay on the review path even when every other gate
  // would pass - first-party hosting never proves the subject by itself (the subject
  // gate below still applies), but it is a necessary condition for trusting the repair.
  if (classifySource(page.url, claim.company) !== 'first_party') return null
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
  const pieces = flat.split(/((?<=[.!?])\s+|\s+[\u00b7\u2022|]\s+|\s+-\s+)/)
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
  const excerpt = norm(c.excerpt)
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
    // Years mentioned near the quote: the claimed year must not contradict the page.
    const near = text.slice(Math.max(0, at - 300), at + excerpt.length + 300)
    const years = [...near.matchAll(/\b(19|20)\d{2}\b/g)].map(m => Number(m[0]))
    const claimed = day.getUTCFullYear()
    if (years.includes(claimed)) { dateStatus = 'verified'; confidence += 15 }
    else if (years.length > 0 && Math.max(...years) < claimed) return { ok: false, reason: 'date_conflict' }
    else { dateStatus = 'unverified'; confidence -= 15 }
  } else {
    confidence -= 15
  }

  // Contacts survive only if they literally appear on the page.
  let contact: string | null = null
  if (c.contact) {
    const raw = c.contact.trim()
    const digits = raw.replace(/\D/g, '')
    const onPage = raw.includes('@') ? text.includes(raw.toLowerCase()) : digits.length >= 7 && page.text.replace(/\D/g, '').includes(digits)
    if (onPage) { contact = raw; confidence += 10 }
  }
  confidence = Math.max(0, Math.min(100, confidence))
  if (confidence < MIN_CONFIDENCE) return { ok: false, reason: 'low_confidence' }
  const passage = text.slice(Math.max(0, at - 800), at + excerpt.length + 800)
  return { ok: true, confidence, contact, dateStatus, retrievedAt: page.retrievedAt, passage }
}
