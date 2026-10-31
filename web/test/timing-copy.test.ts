// #498 whole-card coherence: every timing-visible copy surface keys on the SAME canonical timing state
// (timingUnconfirmedReason / surfaceStoredIntent, lib/scan/scoreboard.ts), so a proof-backed badge can never
// sit next to "timing unconfirmed" copy, and an unconfirmed card names the actual gap. Proof of the event day
// is never buying need: every state keeps current need unconfirmed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { surfaceStoredIntent, timingUnconfirmedReason } from '../lib/scan/scoreboard.ts'
import { savedGradeWhy, timingHeadline } from '../lib/scan/leads-view.ts'
import { eventDateCopy } from '../lib/scan/date-copy.ts'
import { opportunityCard, type CardLead } from '../lib/scan/opportunity.ts'

const NOW = new Date('2026-10-26T12:00:00Z')
const day = '2026-10-10'
const graded = { intent: 4, event_date: day, signal: 'Hiring AEs', signal_kind: null }

test('canonical state: reason is null exactly when the badge says proof_backed', () => {
  const cases: [object, { windowDays?: number | null; timingRequired?: boolean }][] = [
    [{ ...graded, event_date_proof: 'page_bound' }, {}],
    [{ ...graded, event_date_proof: 'page_bound' }, { windowDays: 90 }],
    [{ ...graded, event_date_proof: 'ats_structured' }, { windowDays: 90 }],
    [{ ...graded, event_date_proof: null }, {}],
    [{ ...graded, event_date_proof: 'page_bound' }, { timingRequired: true }],
    [{ ...graded, event_date_proof: 'page_bound' }, { windowDays: 5 }],
    [{ intent: null, event_date: day, event_date_proof: 'page_bound' }, {}],
    [{ ...graded, event_date: '2026-13-01', event_date_proof: 'page_bound' }, {}],
    [{ ...graded, event_date: '2026-12-31', event_date_proof: 'page_bound' }, {}],
    [{ ...graded, event_date_proof: 'ats_structured', signal: 'Raised seed round' }, { windowDays: 90 }],
  ]
  for (const [l, opts] of cases) {
    const o = { now: NOW, ...opts }
    const reason = timingUnconfirmedReason(l as never, o)
    const t = surfaceStoredIntent(l as never, o)
    assert.equal(t.timing, reason === null ? 'proof_backed' : 'unconfirmed', `${JSON.stringify(l)} ${JSON.stringify(opts)}`)
    assert.equal(t.intent, reason === null ? 4 : 0)
  }
})

test('reason matrix: each gap is named, in rule order', () => {
  const at = (l: object, opts: object = {}) => timingUnconfirmedReason(l as never, { now: NOW, ...opts })
  assert.equal(at({ intent: null, event_date: day, event_date_proof: 'page_bound' }), 'no_saved_grade')
  assert.equal(at({ ...graded, event_date_proof: 'page_bound' }, { timingRequired: true }), 'unresolved_recency_bound')
  assert.equal(at({ ...graded, event_date_proof: null }), 'no_proof')
  assert.equal(at({ ...graded, event_date_proof: 'structured_same_event' }), 'no_proof')
  assert.equal(at({ ...graded, event_date_proof: 'ats_structured', signal: 'Raised seed round' }), 'proof_kind_mismatch')
  assert.equal(at({ ...graded, event_date: '2026-13-01', event_date_proof: 'page_bound' }), 'bad_date')
  assert.equal(at({ ...graded, event_date: null, event_date_proof: 'page_bound' }), 'bad_date')
  assert.equal(at({ ...graded, event_date: '2026-12-31', event_date_proof: 'page_bound' }), 'future_date')
  assert.equal(at({ ...graded, event_date_proof: 'page_bound' }, { windowDays: 5 }), 'out_of_window')
  assert.equal(at({ ...graded, event_date_proof: 'page_bound' }, { windowDays: 90 }), null)
})

test('headline: proof_backed never claims timing unconfirmed, and never claims need', () => {
  const pb = { timing: 'proof_backed' as const, reason: null }
  const h = savedGradeWhy({ why: 'rationale', fit: 4 }, pb)
  assert.match(h, /^Event timing is verified against the cited source\./)
  assert.doesNotMatch(h, /timing (is |are )?unconfirmed/i)
  assert.match(h, /Current need is unconfirmed\./)
  assert.match(h, /historical, not a currentness verdict/)
  assert.ok(savedGradeWhy({ why: null, fit: null, intent: null, action: null }, pb).startsWith('This lead has no saved grade. ' + timingHeadline(pb)))
})

test('headline: unconfirmed states name the gap; need stays unconfirmed', () => {
  assert.match(savedGradeWhy({ why: 'x' }, { timing: 'unconfirmed', reason: 'bad_date' }), /^The claimed event date is invalid\./)
  assert.match(savedGradeWhy({ why: 'x' }, { timing: 'unconfirmed', reason: 'future_date' }), /^The claimed event date is in the future\./)
  assert.match(savedGradeWhy({ why: 'x' }, { timing: 'unconfirmed', reason: 'out_of_window' }), /^The claimed event date is outside the freshness window\./)
  const u = savedGradeWhy({ why: 'x' }, { timing: 'unconfirmed', reason: 'unresolved_recency_bound' })
  assert.match(u, /^The request asks for a recent event but sets no time window/)
  assert.doesNotMatch(u, /proof-backed/i)
  assert.match(savedGradeWhy({ why: 'x' }, { timing: 'unconfirmed', reason: 'no_proof' }), /^Event timing and current need are unconfirmed\./)
  // Legacy callers (no timing arg) keep the original wording.
  assert.equal(savedGradeWhy({ why: 'x' }), 'Event timing and current need are unconfirmed. Saved grades are historical, not a currentness verdict.')
})

test('date copy: proof-backed drops "claimed/association unconfirmed", keeps need unconfirmed', () => {
  assert.equal(eventDateCopy(day, 'verified', 'proof_backed'), `${day} (event day verified on the cited source; current need unconfirmed)`)
  assert.equal(eventDateCopy(day, 'verified', 'unconfirmed'), `${day} (claimed event day; event association and current need unconfirmed)`)
  assert.equal(eventDateCopy(day, 'verified'), `${day} (claimed event day; event association and current need unconfirmed)`)
  assert.equal(eventDateCopy(null, null, 'proof_backed'), 'event date unknown - current need not confirmed')
})

const base: CardLead = {
  id: 'a'.repeat(24), company: 'Acme', signal: 'Opened a second site', source_url: 'https://acme.example/news',
  evidence_excerpt: 'Acme opened its second site', event_date: day, date_status: 'verified',
  review_reason: null, fit: 4, intent: 4, why: 'rationale', confidence: 90, human_confirmed_at: 1,
  icp_match: null, company_domain: 'acme.example', contact: null, currentness_held: true, window_held: false, enrichments: [],
}
test('opportunity card: proof-backed date is a fact, and the next action stops asking to confirm timing', () => {
  const c = opportunityCard({ ...base, timing: 'proof_backed' }, '', NOW)
  assert.ok(c.facts.includes(`The cited source dates the event to ${day}.`))
  assert.ok(!c.assumptions.some(a => /event day as claimed/.test(a)))
  assert.match(c.whyNow.dateNote, new RegExp(`^${day} \\(event day verified on the cited source`))
  assert.equal(c.next, 'Review the source before any outreach.')
})
test('opportunity card: unconfirmed keeps the claimed-day assumption and the confirm-timing next action', () => {
  const c = opportunityCard({ ...base, timing: 'unconfirmed' }, '', NOW)
  assert.ok(c.assumptions.includes(`The date ${day} is the event day as claimed; the page was not shown to date the event itself.`))
  assert.equal(c.next, 'Review the source to confirm the timing before any outreach.')
  const legacy = opportunityCard({ ...base }, '', NOW)
  assert.equal(legacy.next, 'Review the source to confirm the timing before any outreach.')
})
