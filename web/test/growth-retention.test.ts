// lib/growth/retention.ts: the one retention/coverage definition both funnel reports import (#404). Pure, synthetic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { coverageAt, coverageCounts, retention, retentionRate, RETENTION } from '../lib/growth/retention.ts'

const D = 86400, T = 1_800_000_000 // day 0 = T
const day = (d: number) => T + d * D
// payments as [day paid, service period start day, end day] (no period: a one-off charge)
type P = [number, number?, number?]
const pays = (ps: P[], refunded: number[] = []) => ps.map(([d, s, e]) => ({ at: day(d), refunded: refunded.includes(d), period_start: s === undefined ? null : day(s), period_end: e === undefined ? null : day(e) }))
const at = (days: number[], cutoffDay: number, o: { endDay?: number; refunded?: number[] } = {}) => retention({
  payments: pays(days.map(d => [d, d, d + 30] as P), o.refunded), ended_at: o.endDay === undefined ? null : day(o.endDay), cutoff: day(cutoffDay),
})
const cov = (ps: P[], cutoffDay: number, o: { endDay?: number; serviceUntil?: number; refunded?: number[] } = {}) =>
  retention({ payments: pays(ps, o.refunded), ended_at: o.endDay === undefined ? null : day(o.endDay), service_until: o.serviceUntil === undefined ? null : day(o.serviceUntil), cutoff: day(cutoffDay) }).coverage_at_cutoff

test('review cases: one payment and no end is not covered 200 days later; a renewal at day 100 is not day-30 retention', () => {
  const single = at([0], 200)
  assert.equal(single.coverage_at_cutoff, 'unknown', 'no end event recorded is not coverage'); assert.equal(single.day30.retained, false)
  const lapse = at([0, 100], 200)
  assert.equal(lapse.day30.retained, false, 'renewed only at day 100: not retained at day 30'); assert.equal(lapse.day30.renewal_at, null)
  assert.equal(lapse.coverage_at_cutoff, 'unknown', 'the day-100 period ran out at day 130')
})

test('coverage uses each invoice\'s actual service period: monthly, annual, prorated and one-off payments', () => {
  assert.equal(cov([[0, 0, 30]], 20), 'covered'); assert.equal(cov([[0, 0, 30]], 30), 'unknown', 'period end is exclusive')
  assert.equal(cov([[0, 0, 365]], 200), 'covered', 'an annual plan covers day 200 (no 30-day assumption)')
  assert.equal(cov([[0, 0, 365]], 366), 'unknown')
  assert.equal(cov([[10, 10, 18]], 15), 'covered', 'a prorated 8-day period'); assert.equal(cov([[10, 10, 18]], 20), 'unknown', 'not a full month')
  assert.equal(cov([[0]], 5), 'unknown', 'a one-off charge with no service period is no coverage evidence')
  assert.equal(cov([[0, 0, 30]], 20, { refunded: [0] }), null, 'fully refunded: never paid')
  assert.equal(cov([[0, 0, 30], [30, 30, 60]], 45), 'covered', 'a renewal\'s own period')
})

test('cancellation versus prepaid service: an end on day 5 is not covered on day 10 unless billing shows the service ran on', () => {
  assert.equal(cov([[0, 0, 30]], 10, { endDay: 5 }), 'not_covered', 'immediate cancellation: the invoice period does not outlive the end')
  assert.equal(cov([[0, 0, 30]], 4, { endDay: 5 }), 'covered', 'before the end')
  assert.equal(cov([[0, 0, 30]], 10, { endDay: 5, serviceUntil: 30 }), 'covered', 'cancelled on day 5 with service paid to day 30')
  assert.equal(cov([[0, 0, 30]], 31, { endDay: 5, serviceUntil: 30 }), 'not_covered', 'after the prepaid service ran out')
  assert.equal(cov([[0, 0, 365]], 100, { endDay: 60 }), 'not_covered', 'an annual plan cancelled immediately on day 60')
})

test('rejoin: ended, then paid again: not day-30 retained, covered in the new period, not covered between', () => {
  const rejoin = { payments: pays([[0, 0, 30], [100, 100, 130]]), ended_at: day(40), cutoff: day(110) }
  const r = retention(rejoin)
  assert.equal(r.day30.retained, false); assert.equal(r.coverage_at_cutoff, 'covered')
  assert.equal(coverageAt(rejoin, day(50)), 'not_covered'); assert.equal(coverageAt(rejoin, day(20)), 'covered')
  assert.equal(retention({ payments: pays([[0, 0, 30], [100]]), ended_at: day(40), cutoff: day(110) }).coverage_at_cutoff, 'unknown', 'a rejoin payment without a period proves nothing either way')
})

test('day-30 window: renewals from day 25 to day 35 count; outside it they do not; the cohort waits for the window to close', () => {
  assert.equal(at([0, 25], 40).day30.retained, true); assert.equal(at([0, 35], 40).day30.retained, true)
  assert.equal(at([0, 24.99], 40).day30.retained, false); assert.equal(at([0, 35.01], 40).day30.retained, false, 'upper bound')
  assert.equal(at([0, 30], 34.99).day30.eligible, false, 'window still open: not judged'); assert.equal(at([0, 30], 34.99).day30.retained, null)
  assert.equal(at([0, 30], 35).day30.eligible, true)
  assert.equal(at([0, 30], 40, { endDay: 20 }).day30.retained, false, 'ended before day 30')
  assert.equal(at([0, 30], 40, { endDay: 30 }).day30.retained, false, 'ended exactly at day 30: ended by day 30')
  assert.equal(at([0, 30], 40, { endDay: 30.01 }).day30.retained, true, 'ended just after day 30')
  assert.equal(at([0, 30], 40, { refunded: [30] }).day30.retained, false, 'a refunded renewal is not a renewal')
  assert.equal(at([0, 30], 40, { refunded: [0] }).first_paid_at, day(30), 'a refunded first payment is not the first payment')
})

test('each rule is one named setting: early and late move only their own boundary; future rows ignored', () => {
  const r = (days: number[], cutoffDay: number, rules = {}) => retention({ payments: pays(days.map(d => [d] as P)), ended_at: null, cutoff: day(cutoffDay) }, rules)
  assert.equal(r([0, 27], 40, { renewalEarlyDays: 2 }).day30.retained, false); assert.equal(r([0, 28], 40, { renewalEarlyDays: 2 }).day30.retained, true)
  assert.equal(r([0, 40], 60, { renewalLateDays: 10 }).day30.retained, true); assert.equal(r([0, 30], 39, { renewalLateDays: 10 }).day30.eligible, false)
  assert.equal(cov([[0, 0, 30], [50, 50, 80]], 40), 'unknown', 'a payment after the cutoff does not exist yet')
  assert.ok(!('period_days' in RETENTION), 'no assumed service length')
  assert.match(RETENTION.labels.day30, /historical/); assert.match(RETENTION.labels.coverage, /actual service period/)
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
