// lib/growth/retention.ts: the one retention/coverage definition both funnel reports import (#404). Pure, synthetic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { coverageAt, coverageCounts, retention, retentionRate, RETENTION } from '../lib/growth/retention.ts'

const D = 86400, T = 1_800_000_000 // day 0 = T
const at = (days: number[], cutoffDay: number, o: { endDay?: number; refunded?: number[] } = {}) => retention({
  payments: days.map(d => ({ at: T + d * D, refunded: (o.refunded ?? []).includes(d) })),
  ended_at: o.endDay === undefined ? null : T + o.endDay * D, cutoff: T + cutoffDay * D,
})

test('review cases: one payment and no end is not covered 200 days later; a renewal at day 100 is not day-30 retention', () => {
  const single = at([0], 200)
  assert.equal(single.coverage_at_cutoff, 'unknown', 'no end event recorded is not coverage'); assert.equal(single.day30.retained, false)
  const lapse = at([0, 100], 200)
  assert.equal(lapse.day30.retained, false, 'renewed only at day 100: not retained at day 30'); assert.equal(lapse.day30.renewal_at, null)
  assert.equal(lapse.coverage_at_cutoff, 'unknown', 'the day-100 period ran out at day 130')
})

test('rejoin: ended, then paid again: not day-30 retained, but covered while the new period runs, not covered after a recorded end', () => {
  const rejoin = { payments: [{ at: T, refunded: false }, { at: T + 100 * D, refunded: false }], ended_at: T + 40 * D, cutoff: T + 110 * D }
  const r = retention(rejoin)
  assert.equal(r.day30.retained, false); assert.equal(r.coverage_at_cutoff, 'covered', 'the rejoin payment covers day 100-130')
  assert.equal(coverageAt(rejoin, T + 50 * D), 'not_covered', 'between the recorded end and the rejoin')
  assert.equal(coverageAt(rejoin, T + 20 * D), 'covered', 'inside the first paid period')
  assert.equal(at([0], 50, { endDay: 20 }).coverage_at_cutoff, 'not_covered')
})

test('day-30 window: renewals from day 25 to day 35 count; outside it they do not; the cohort waits for the window to close', () => {
  assert.equal(at([0, 25], 40).day30.retained, true); assert.equal(at([0, 35], 40).day30.retained, true)
  assert.equal(at([0, 24.99], 40).day30.retained, false); assert.equal(at([0, 35.01], 40).day30.retained, false, 'upper bound')
  assert.equal(at([0, 30], 34.99).day30.eligible, false, 'window still open: not judged'); assert.equal(at([0, 30], 34.99).day30.retained, null)
  assert.equal(at([0, 30], 35).day30.eligible, true)
  assert.equal(at([0, 30], 40, { endDay: 20 }).day30.retained, false, 'ended before day 30')
  assert.equal(at([0, 30], 40, { refunded: [30] }).day30.retained, false, 'a refunded renewal is not a renewal')
  assert.equal(at([0, 30], 40, { refunded: [0] }).first_paid_at, T + 30 * D, 'a refunded first payment is not the first payment')
})

test('each rule is one named setting: early, late and period move only their own boundary; future rows ignored', () => {
  const r = (days: number[], cutoffDay: number, rules = {}) => retention({ payments: days.map(d => ({ at: T + d * D, refunded: false })), ended_at: null, cutoff: T + cutoffDay * D }, rules)
  assert.equal(r([0, 27], 40, { renewalEarlyDays: 2 }).day30.retained, false); assert.equal(r([0, 28], 40, { renewalEarlyDays: 2 }).day30.retained, true)
  assert.equal(r([0, 40], 60, { renewalLateDays: 10 }).day30.retained, true); assert.equal(r([0, 30], 39, { renewalLateDays: 10 }).day30.eligible, false)
  assert.equal(r([0], 40, { periodDays: 45 }).coverage_at_cutoff, 'covered'); assert.equal(r([0], 40).coverage_at_cutoff, 'unknown')
  assert.equal(r([0, 50], 40).coverage_at_cutoff, 'unknown', 'a payment after the cutoff does not exist yet')
  assert.match(RETENTION.labels.day30, /historical/); assert.match(RETENTION.labels.coverage, /current/)
})

test('each metric over its own labelled cohort; the day-30 rate cannot exceed 100%', () => {
  const people = [at([0, 30], 40), at([0], 40), at([0, 30], 34), at([], 40), at([0], 20)]
  const rr = retentionRate(people)
  assert.deepEqual({ retained: rr.retained, eligible: rr.eligible }, { retained: 1, eligible: 2 }); assert.equal(rr.rate, 0.5)
  assert.match(rr.cohort, /renewal window has closed/)
  const cc = coverageCounts(people)
  assert.deepEqual({ covered: cc.covered, not_covered: cc.not_covered, unknown: cc.unknown, n: cc.cohort_size }, { covered: 3, not_covered: 0, unknown: 1, n: 4 })
  assert.match(cc.cohort, /every customer who has paid/)
  assert.equal(retentionRate([at([0, 30], 34), at([0, 30], 34)]).rate, null)
})
