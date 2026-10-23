import type { Page } from './fetch-page.ts'

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
// fetched source text, this extractor may attach a VERBATIM window - but only for directly
// supported, active, concrete hiring assertions. Adversarial review killed the wider version:
// occurrence is not support, and every unresolved facet must route to review, never attach.
// Gates (all deterministic, no paid calls, no fetches):
//   claim hygiene - claim-side negation ("not hiring"), past/completed tense ("hired last
//              year"), and any analyst gloss marker ("indicating/suggesting...") REJECT the
//              candidate to review. Unsupported text is never trimmed silently.
//   event    - hiring claims only. Funding/expansion/launch claims have no attachable kind
//              and stay on the review path (generic tokens like "series" launder too easily).
//   role     - the claim must name at least one concrete role; every named role must appear
//              in the window. Vague "is hiring" claims do not attach.
//   quantity - an explicit count tied to a role must equal the number of DISTINCT listing
//              segments naming it - a repeated identical posting is one opening, not two.
//   entity   - the company is named in the window or within +/-300 chars of it (same spirit
//              as the verifier's excerpt-or-title rule; a rival's story never attaches).
//   negation - closed/filled/not-hiring markers in the window reject it.
//   boilerplate - navigation-dominated windows reject.
// Any unresolved facet -> null -> the candidate follows the unchanged honest needs_review
// path with the model's original text preserved. The verifier is untouched and re-checks
// any attached window against its own live fetch. The claim text is never rewritten.
const ROLE_LEXICON = [
  'account executive', 'chief of staff', 'sales development representative', 'business development representative',
  'account manager', 'customer success manager', 'sales manager', 'sales operations manager', 'crm administrator',
  'revenue operations', 'head of sales', 'vp of sales', 'director of sales', 'sales director', 'growth manager',
  'product manager', 'engineering manager', 'solutions engineer', 'forward deployed engineer', 'machine learning engineer',
  'full stack engineer', 'software engineer', 'data scientist', 'data engineer', 'designer', 'developer',
  'recruiter', 'operations manager', 'marketing manager', 'gtm intern', 'intern', 'analyst', 'engineer',
]
// Hiring only: funding/expansion/launch tokens launder too easily ("a series of community
// events" is not a Series A), so those claims stay on the review path.
const KIND_TOKENS: Record<string, string[]> = {
  hiring: ['hiring', 'hire', 'hires', 'recruiting', 'recruit', 'recruits', 'opening', 'openings', 'vacancy', 'vacancies', 'apply', 'careers'],
}
// Claim-side hygiene: negation, past/completed tense, and analyst gloss all route to review.
const CLAIM_REJECT = /\b(?:not currently hiring|is not hiring|isn't hiring|are not hiring|aren't hiring|no longer hiring|hired|was hiring|were hiring|has hired|have hired|last (?:year|month|quarter)|indicating|suggesting|signalling|signaling|pointing to|which suggests?)\b/i
const CLOSED_OR_NEGATED = /\b(?:no longer accepting applications|this (?:job|position|role) is no longer (?:available|open)|this (?:job|position|role) has (?:closed|expired|been filled)|applications for this (?:job|position|role) are closed|not currently hiring|is not hiring|are not hiring|no longer hiring)\b/i
const BOILER = new Set(['careers', 'jobs', 'apply', 'home', 'about', 'contact', 'menu', 'search', 'login', 'sign', 'copyright', 'privacy', 'terms', 'cookie', 'cookies', 'subscribe', 'follow', 'share', 'blog', 'press'])
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

const rolePattern = (role: string) => new RegExp(`\\b${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'g')

function claimFacets(claimText: string) {
  const concrete = norm(claimText)
  const kinds = new Set<string>()
  const toks = new Set(concrete.split(' '))
  for (const [kind, words] of Object.entries(KIND_TOKENS)) for (const w of words) if (toks.has(w)) { kinds.add(kind); break }
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
  return { kinds, roles: deduped, multi }
}

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
  const wset = new Set(wtoks)
  for (const kind of facets.kinds) {
    // A role listing on a careers page is itself hiring evidence.
    const tokenHit = KIND_TOKENS[kind].some(t => wset.has(t))
    const roleHit = kind === 'hiring' && facets.roles.length > 0
    if (!tokenHit && !roleHit) return false
  }
  // Count DISTINCT listing segments naming the role: a repeated identical posting
  // is one opening, not two.
  const segments = [...new Set(win.split(/(?<=[.!?])\s+|\s+[\u00b7\u2022|]\s+|\s+-\s+/).map(t => norm(t)).filter(t => t.length >= 8))]
  for (const { role, want } of facets.roles) {
    const re = rolePattern(role)
    const inSegments = segments.filter(seg => { re.lastIndex = 0; return re.test(seg) }).length
    if (inSegments === 0) return false
    if (want !== null && inSegments !== want) return false
  }
  if (facets.multi) {
    const distinct = facets.roles.filter(({ role }) => { const re = rolePattern(role); return segments.some(seg => { re.lastIndex = 0; return re.test(seg) }) }).length
    if (distinct < 2) return false
  }
  return true
}

// Returns the shortest verbatim window of the page that supports every material facet of
// the claim, or null. When the model's excerpt is already verbatim, returns null (no-op).
export function supportedEvidenceWindow(claim: { company: string; signal: string; excerpt: string }, page: { text: string; title?: string }): string | null {
  const text = page.text ?? ''
  const src = norm(text)
  if (!claim.excerpt || src.length < 20) return null
  if (src.includes(norm(claim.excerpt))) return null
  if (CLAIM_REJECT.test(`${claim.signal} ${claim.excerpt}`)) return null // negation, past tense or gloss: review, never attach
  const facets = claimFacets(`${claim.signal} ${claim.excerpt}`)
  if (facets.kinds.size === 0) return null // no concrete attachable event claimed
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
