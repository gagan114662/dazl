// #1910 offline slice: a second shape family through all four Ready gates in one table. The first three families
// (dentists Mississauga, commercial cleaning Toronto, marketing agencies Austin) are pinned by #1976, #1978, #1982 and
// #1986; a shape-specific assumption those share would hide, so these two rows differ in what holds the leads and in
// which causes the research group shows. Each row drives: counts equal cards, no zero-card scan, confirmable-vs-research
// and the draft gate's agreement, and the words naming only the reasons present.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readyRepeats, visibleReadyLeads } from '../lib/scan/leads-view.ts'
import { REVIEWABLE, RESEARCH_REASONS, CAUSE_TEXT, reviewIsActionable, researchCause, researchHint, researchTip, uncheckableCause, type ResearchCause } from '../lib/lead-state.ts'
import { windowHeld } from '../lib/outreach/currentness.ts'

interface Lead { company: string; review_reason?: string | null; seen_before?: number | boolean | null }
interface Shape {
  query: string
  shown: Lead[]
  held: string[]
  causes: ResearchCause[]
  absent: ResearchCause[]
}

const NOW = new Date('2026-11-26T12:00:00Z')
const WINDOW = JSON.stringify({ window_days: 30 })

const shapes: Shape[] = [
  {
    query: 'Accountants in Calgary',
    shown: [
      { company: 'firm with a dated new-partner notice and a named managing partner' },
      { company: 'firm with a dated notice and no named person' },
      { company: 'firm seen in an earlier scan', seen_before: 1 },
      { company: 'firm whose site would not load', review_reason: 'blocked_by_site' },
    ],
    held: ['blocked_by_site', 'location_mismatch', 'outside_window'],
    causes: ['place', 'older', 'unsupported'],
    absent: ['customer', 'contact', 'unfit'],
  },
  {
    query: 'HVAC companies in Denver',
    shown: [
      { company: 'contractor with a dated hiring ad and a named service manager' },
      { company: 'contractor whose page needed javascript', review_reason: 'needs_javascript' },
      { company: 'contractor whose proof is another firm as its customer', review_reason: 'counterparty_signal' },
    ],
    held: ['needs_javascript', 'counterparty_signal', 'job_closed', 'event_date_stale'],
    causes: ['customer', 'closed', 'older'],
    absent: ['place', 'unfit', 'contact'],
  },
]

const readyOf = (s: Shape) => s.shown.filter(l => !l.review_reason)
const dateFor = (reason: string) =>
  reason.includes('undated') ? null : reason.includes('future') ? '2027-03-01' : reason.includes('stale') || reason.includes('outside_window') ? '2026-06-01' : '2026-11-20'
const heldByWindow = (reason: string) => windowHeld({ event_date: dateFor(reason), icp: WINDOW, query: null }, NOW)
const heldForDraft = (reason: string) => uncheckableCause(reason) !== null || heldByWindow(reason)

for (const shape of shapes) {
  test(`#1910 ${shape.query}: ready count, cards and the toggle agree`, () => {
    const { ready } = readyRepeats(shape.shown)
    assert.equal(ready, readyOf(shape).length)
    assert.equal(visibleReadyLeads(shape.shown, true).length, ready, 'the list never disagrees with the count')
    if (ready > 0) assert.ok(visibleReadyLeads(shape.shown, false).length > 0, 'a scan with ready leads shows a card')
  })

  test(`#1910 ${shape.query}: every hold is classified and the page agrees with the draft gate`, () => {
    for (const reason of shape.held) {
      assert.ok(REVIEWABLE.has(reason) || RESEARCH_REASONS.has(reason), `${reason} is classified, not unknown`)
      const confirmable = reviewIsActionable({ review_reason: reason, window_held: heldByWindow(reason) })
      assert.equal(confirmable, !heldForDraft(reason), `${reason}: offered exactly when a draft can follow`)
    }
  })

  test(`#1910 ${shape.query}: the card words name only the reasons this group has`, () => {
    for (const cause of shape.causes) assert.ok(CAUSE_TEXT[cause]?.trim(), `${cause} has words`)
    const tip = researchTip(shape.causes).toLowerCase()
    for (const cause of shape.causes) assert.ok(tip.includes(CAUSE_TEXT[cause].toLowerCase()), `${cause} is named`)
    for (const absent of shape.absent) assert.ok(!tip.includes(CAUSE_TEXT[absent].toLowerCase()), `${absent} is not named`)
    const hint = researchHint(shape.causes)
    if (shape.causes.includes('need')) assert.doesNotMatch(hint, /none has verified, dated evidence/i)
    else assert.match(hint, /none has verified, dated evidence/i)
  })
}

test('#1910 this family reaches the same causes the first one does, through researchCause', () => {
  const older = researchCause({ id: 'a', review_reason: 'outside_window', event_date: '2026-06-01' } as never)
  const customer = researchCause({ id: 'b', review_reason: 'counterparty_signal', event_date: '2026-11-20' } as never)
  const closed = researchCause({ id: 'c', review_reason: 'job_closed', event_date: '2026-11-20' } as never)
  assert.deepEqual([older, customer, closed], ['older', 'customer', 'closed'])
  for (const cause of [older, customer, closed]) assert.ok(CAUSE_TEXT[cause].trim(), `${cause} has words`)
})
