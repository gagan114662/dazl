// Person and contact-route verification (#781, part of #395): is the named contact CURRENT at the company, from pages somebody else fetched.
// Pure: no fetch, no model, no clock (as_of is passed in). Returns what the #394 contract reads as LeadEvidence.contact.person, so a former employee fails
// contact.usable, an unconfirmed one is unknown (never pass), and a generic or hiring inbox fails there too (lib/evals/contract.ts).
//
// Rules, each with a seeded test in test/person-verification.test.ts:
//  - A page speaks about the person only when one sentence names BOTH the person and the company (whole tokens). A page about a same-name person at another
//    company supports nothing.
//  - FORMER beats current: any fresh page whose sentence about the person at the company carries a departure cue (former, ex-, left, previously, resigned,
//    stepped down, until <year>, alumni, formerly) makes the person former, even if another page says current.
//  - CURRENT needs a fresh page: a sentence with a present-tense cue (is, joined, currently, serves as, appointed, named, now) and no departure cue, on a
//    page that STATES a day within `max_age_days` before as_of (and not after it). An undated or stale page is unknown, never current.
//  - Unknown stays unknown: no page, no dated page, or no sentence about this person at this company.
import { isDay } from './contract.ts'

export interface PersonClaim { name: string; company: string; title?: string | null }
export interface PersonPage { url: string; text: string }
export interface PersonOptions { as_of: string; max_age_days?: number }
export interface PersonResult { person: 'current' | 'former' | 'unknown'; title_matches: 'pass' | 'unknown'; reason: string; evidence: string[] }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const has = (hay: string, needle: string) => needle.trim() !== '' && ` ${norm(hay)} `.includes(` ${norm(needle)} `)
const FORMER = /\b(former|formerly|ex|previously|used to|left|departed|stepped down|resigned|alumnus|alumna|alumni|moved on|until \d{4}|no longer)\b/i
const CURRENT = /\b(is|joined|joins|currently|serves as|works as|appointed|named|promoted|now|hired)\b/i
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

// The sentences of a page that name both the person and the company.
const sentences = (text: string, p: PersonClaim) => text.split(/(?<=[.!?])\s+|\n+/).filter(x => has(x, p.name) && has(x, p.company))

export function verifyPerson(p: PersonClaim, pages: PersonPage[], o: PersonOptions): PersonResult {
  const max = o.max_age_days ?? 365
  const fresh = (pg: PersonPage) => statedDays(pg.text).some(d => { const age = day(o.as_of) - day(d); return age >= 0 && age <= max })
  let current: { url: string; sentence: string } | null = null
  for (const pg of pages) {
    const about = sentences(pg.text, p)
    if (!about.length || !fresh(pg)) continue
    if (about.some(x => FORMER.test(x))) return { person: 'former', title_matches: 'unknown', reason: `a page dated within ${max} days says ${p.name} has left ${p.company}`, evidence: [pg.url] }
    const now = about.find(x => CURRENT.test(x))
    if (now && !current) current = { url: pg.url, sentence: now }
  }
  if (!current) return { person: 'unknown', title_matches: 'unknown', reason: `no dated page within ${max} days confirms ${p.name} at ${p.company}`, evidence: [] }
  return { person: 'current', title_matches: p.title && has(current.sentence, p.title) ? 'pass' : 'unknown', reason: `a page dated within ${max} days says ${p.name} is at ${p.company}`, evidence: [current.url] }
}

// The LeadEvidence.contact the contract reads: the route plus what the independent check found about the person.
export const contactEvidence = (email: string | null | undefined, phone: string | null | undefined, r: PersonResult) => ({ email: email ?? null, phone: phone ?? null, person: r.person })
