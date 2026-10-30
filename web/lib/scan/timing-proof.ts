// Event-association proof: when may a lead's timing count as supported? Fit/use-case reasoning is about WHO the company is and is kept apart from timing,
// which is about WHEN something happened to it. Timing is "supported" only from verified proof, never from a model grade or a copied date (#377):
//   identity-bound  - the lead is a kept verified lead (a quote on the cited page, company named) and the company is named in the verbatim quote itself;
//   dated           - the claimed event day is stated in that same verbatim quote;
//   current         - not held for window or currentness review.
// Publication dates and a model's date claim alone never satisfy "dated". Everything else is unknown/held, not a negative verdict.
import { dateStatedInText } from './date-in-text.ts'
import { companyKey, hasPhrase, norm } from './evidence.ts'

export interface TimingInput {
  company: string; excerpt?: string | null; evidence_excerpt?: string | null; event_date?: string | null; date_status?: string | null
  confidence?: number | null; review_reason?: string | null; quarantined_at?: number | null; currentness_held?: boolean; window_held?: boolean
}
export type TimingStatus = 'supported' | 'unknown' | 'held'
export interface Timing { status: TimingStatus; supported: boolean; identityBound: boolean; dated: 'quote' | null; reason: string }

export function timingOf(l: TimingInput): Timing {
  const quote = l.excerpt ?? l.evidence_excerpt ?? ''
  const key = companyKey(l.company)
  const kept = l.confidence != null && !l.review_reason && !l.quarantined_at
  const identityBound = kept && key.length >= 2 && hasPhrase(norm(quote), key)
  const day = l.event_date && /^\d{4}-\d{2}-\d{2}$/.test(l.event_date) ? l.event_date : null
  // A stored 'verified' label alone is a legacy flag and proves nothing here: the day must be stated in the verbatim quote that names the company.
  const dated: Timing['dated'] = day && dateStatedInText(day, quote) ? 'quote' : null
  const base = { identityBound, dated }
  if (l.window_held || l.currentness_held) return { status: 'held', supported: false, ...base, reason: 'Held for time-window or currentness review: the timing is research only.' }
  if (!identityBound) return { status: 'unknown', supported: false, ...base, reason: 'The lead is not identity-bound to its quote, so no event timing is attributed to it.' }
  if (!dated) return { status: 'unknown', supported: false, ...base, reason: day ? 'The event date is a claim: the quote does not state it, and a publication date or model date alone does not prove timing.' : 'No event date: timing is unknown.' }
  return { status: 'supported', supported: true, ...base, reason: `The quote itself states ${day} and names the company.` }
}

// Sentences that assert WHEN something happened or that a need is current. Timing the proof does not support must not be asserted in the fit rationale: those
// sentences are dropped (the rest of the rationale is kept as the model wrote it), and a note says timing is unconfirmed.
const TIMING_CLAIM = /\b(?:now|right now|today|currently|at the moment|just\s+(?:raised|opened|announced|launched|closed|hired|signed)|recently|this (?:week|month|quarter|year)|yesterday|last (?:week|month)|urgent(?:ly)?|immediate(?:ly)?|(?:is|are) (?:currently |now )?(?:expanding|growing|scaling|hiring|raising)|time-?sensitive)\b/i
export function fitRationale(why: string, timingSupported: boolean): string {
  if (timingSupported) return why
  const kept = why.split(/(?<=[.!?])\s+/).filter(s => s.trim() && !TIMING_CLAIM.test(s))
  const text = kept.join(' ').trim()
  return text || 'Fit rationale not written for this lead. Event timing is unconfirmed.'
}
