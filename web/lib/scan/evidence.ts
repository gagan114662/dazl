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
// verifier then rejects real signals (excerpt_not_on_page). Where the pipeline already holds
// the fetched source text, snap a paraphrase to the closest VERBATIM window of that text.
// Zero extra paid calls, zero extra fetches. This never weakens verification: the snapped
// quote is re-checked by verifyEvidence against the verifier's own live fetch, so a window
// that is not really on the page still fails honestly. Returns null when there is nothing
// defensible to snap to - the original excerpt then fails verification as before.
export function snapExcerpt(excerpt: string, claimText: string, sourceText: string): string | null {
  const src = norm(sourceText)
  if (!excerpt || src.length < 20) return null
  if (src.includes(norm(excerpt))) return null // already verbatim - nothing to do
  const claimTokens = new Set(norm(`${excerpt} ${claimText}`).split(' ').filter(w => w.length > 3))
  if (claimTokens.size === 0) return null
  const parts = sourceText.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+|\s+[\u00b7\u2022|]\s+|\s+-\s+/).map(t => t.trim()).filter(t => norm(t).length >= 8)
  let bestText: string | null = null
  let bestShared = 0
  for (let i = 0; i < parts.length; i++) {
    let win = ''
    for (let j = i; j < parts.length; j++) {
      win = win ? `${win} ${parts[j]}` : parts[j]
      if (win.length > 320) break
      const toks = new Set(norm(win).split(' ').filter(w => w.length > 3))
      let shared = 0
      for (const t of claimTokens) if (toks.has(t)) shared++
      if (shared >= 3 && shared >= Math.ceil(claimTokens.size / 5) && norm(win).length >= 20 && (shared > bestShared || (shared === bestShared && bestText !== null && win.length < bestText.length))) {
        bestText = win
        bestShared = shared
      }
    }
  }
  return bestText
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
