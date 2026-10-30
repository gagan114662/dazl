// lib/growth/retention.ts: the one retention definition both funnel reports use (#404). Pure, synthetic numbers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { retention, retentionRate, RETENTION } from '../lib/growth/retention.ts'

const D = 86400, C = 1_800_000_000 // cutoff
const r = (firstDaysAgo: number, more: number[] = [], o: { ended?: number | null; refunded?: number[] } = {}) => retention({
  payments: [firstDaysAgo, ...more].map(d => ({ at: C - d * D, refunded: (o.refunded ?? []).includes(d) })),
  ended_at: o.ended === undefined || o.ended === null ? null : C - o.ended * D, cutoff: C,
})

test('maturity boundary: eligible exactly at 35 days, not a second before; the not-yet-eligible are in neither count', () => {
  assert.equal(r(35).eligible, true); assert.equal(r(35).retained, false, 'eligible, no renewal')
  const young = retention({ payments: [{ at: C - 35 * D + 1, refunded: false }, { at: C - 5 * D, refunded: false }], ended_at: null, cutoff: C })
  assert.equal(young.eligible, false); assert.equal(young.retained, null, 'renewed but not mature: no headline answer')
  // the 200% case: retained-but-immature customers never enter the numerator
  const rate = retentionRate([young, young, r(40)])
  assert.deepEqual({ retained: rate.retained, eligible: rate.eligible, rate: rate.rate }, { retained: 0, eligible: 1, rate: 0 })
  assert.ok(rate.rate === null || rate.rate <= 1)
})

test('renewal boundary at 25 days, both kinds of evidence required, each reported on its own', () => {
  assert.equal(r(40, [15]).retained, true, 'paid again 25 days after the first')
  assert.equal(r(40, [15.01]).retained, false, 'a hair under 25 days is not the renewal')
  const ended = r(60, [30], { ended: 35 }) // renewed at day 30, ended at day 25 after the first payment (before day 30)
  assert.equal(ended.renewal, true); assert.equal(ended.covered_at_headline, false); assert.equal(ended.retained, false)
  const lateEnd = r(60, [30], { ended: 20 }) // ended at day 40: after the headline mark
  assert.equal(lateEnd.retained, true); assert.equal(lateEnd.covered_at_cutoff, false, 'not covered now, reported separately')
  assert.equal(r(60, [30], { refunded: [30] }).retained, false, 'a refunded renewal is not a renewal')
  assert.equal(r(60, [], { refunded: [60] }).first_paid_at, null, 'a fully refunded only payment is not a payment')
})

test('cutoff: payments and ends after it do not exist yet', () => {
  const x = retention({ payments: [{ at: C - 40 * D, refunded: false }, { at: C + D, refunded: false }], ended_at: C + 2 * D, cutoff: C })
  assert.equal(x.renewal, false); assert.equal(x.retained, false); assert.equal(x.covered_at_cutoff, true)
  assert.equal(retention({ payments: [{ at: C + D, refunded: false }], ended_at: null, cutoff: C }).first_paid_at, null)
})

test('one labelled definition; other windows only by explicit option', () => {
  assert.equal(RETENTION.headline_days, 30); assert.equal(RETENTION.grace_days, 5); assert.match(retentionRate([]).label, /Retained at 30 days/)
  assert.equal(retentionRate([]).rate, null)
  assert.equal(retention({ payments: [{ at: C - 70 * D, refunded: false }, { at: C - 10 * D, refunded: false }], ended_at: null, cutoff: C }, { headlineDays: 60 }).retained, true)
})
