// lib/growth/retention.ts: the one retention/coverage definition both funnel reports import (#404). Pure, synthetic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { coverageAt, coverageCounts, retention, retentionRate, RETENTION } from '../lib/growth/retention.ts'

const D = 86400, T = 1_800_000_000 // day 0 = T
const day = (d: number) => T + d * D
// payments as [day paid, service period start day, end day, ...more periods] (no period: a one-off charge)
type P = [number, ...number[]]
const pays = (ps: P[], refunded: number[] = []) => ps.map(([d, ...se]) => ({ at: day(d), refunded: refunded.includes(d),
  periods: Array.from({ length: Math.floor(se.length / 2) }, (_, k) => ({ start: day(se[2 * k]), end: day(se[2 * k + 1]), subscription: `sub_${k}` })) }))
const at = (days: number[], cutoffDay: number, o: { endDay?: number; refunded?: number[] } = {}) => retention({
  payments: pays(days.map(d => [d, d, d + 30] as P), o.refunded), ends: o.endDay === undefined ? [] : [{ at: day(o.endDay) }], cutoff: day(cutoffDay),
})
const cov = (ps: P[], cutoffDay: number, o: { endDay?: number; refunded?: number[] } = {}) =>
  retention({ payments: pays(ps, o.refunded), ends: o.endDay === undefined ? [] : [{ at: day(o.endDay) }], cutoff: day(cutoffDay) }).coverage_at_cutoff

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

test('one invoice with two service periods and a gap: each period covered on its own dates, the gap is not', () => {
  // the review case: a paid invoice with periods 30-20 days before the cutoff and 20-30 days after it
  const twoPeriods: P = [-30, -30, -20, 20, 30]
  assert.equal(cov([twoPeriods], 0), 'unknown', 'today falls in the gap between the two periods: no coverage invented')
  assert.equal(cov([twoPeriods], -25), 'covered', 'inside the first period')
  assert.equal(cov([twoPeriods], 25), 'covered', 'inside the second period')
  assert.equal(cov([twoPeriods], 19.99), 'unknown', 'just before the second period starts'); assert.equal(cov([twoPeriods], 20), 'covered', 'its first day')
  const later = { payments: pays([twoPeriods]), ends: [], cutoff: day(25) }
  assert.equal(coverageAt(later, day(0)), 'unknown', 'the gap, seen from a later cutoff, is still a gap')
  assert.equal(coverageAt(later, day(-20)), 'unknown', 'a period end is exclusive')
  // two subscriptions on one invoice keep their own identity and intervals
  const ids = pays([[0, 0, 10, 40, 50]])[0].periods.map(p => p.subscription)
  assert.deepEqual(ids, ['sub_0', 'sub_1'])
})

test('an end is when service stopped: an end on day 5 is not covered on day 10, whatever the invoice period said', () => {
  assert.equal(cov([[0, 0, 30]], 10, { endDay: 5 }), 'not_covered', 'immediate cancellation: the invoice period does not outlive the end')
  assert.equal(cov([[0, 0, 30]], 4, { endDay: 5 }), 'covered', 'before the end')
  assert.equal(cov([[0, 0, 365]], 100, { endDay: 60 }), 'not_covered', 'an annual plan cancelled immediately on day 60')
  // a cancellation scheduled for the period end is no end yet: covered until the end arrives (see the webhook test)
  assert.equal(cov([[0, 0, 30]], 10), 'covered'); assert.equal(cov([[0, 0, 30]], 31, { endDay: 30 }), 'not_covered')
})

test('rejoin: ended, then paid again: not day-30 retained, covered in the new period, not covered between', () => {
  const rejoin = { payments: pays([[0, 0, 30], [100, 100, 130]]), ends: [{ at: day(40) }], cutoff: day(110) }
  const r = retention(rejoin)
  assert.equal(r.day30.retained, false); assert.equal(r.coverage_at_cutoff, 'covered')
  assert.equal(coverageAt(rejoin, day(50)), 'not_covered'); assert.equal(coverageAt(rejoin, day(20)), 'covered')
  assert.equal(retention({ payments: pays([[0, 0, 30], [100]]), ends: [{ at: day(40) }], cutoff: day(110) }).coverage_at_cutoff, 'unknown', 'a rejoin payment without a period proves nothing either way')
  assert.equal(coverageAt({ payments: pays([[0, 0, 30], [10, 10, 60]]), ends: [{ at: day(40) }], cutoff: day(50) }, day(50)), 'not_covered', 'paid before the end: the service still stopped at the end')
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
  const r = (days: number[], cutoffDay: number, rules = {}) => retention({ payments: pays(days.map(d => [d, d, d + 30] as P)), ends: [], cutoff: day(cutoffDay) }, rules)
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

test('ends are scoped to their subscription: deleting another subscription leaves this one\'s paid period covered', () => {
  // one customer, two subscriptions: sub_MULTI paid through day 30, sub_other paid through day 20
  const payments = [
    { at: day(0), refunded: false, periods: [{ start: day(0), end: day(30), subscription: 'sub_MULTI' }] },
    { at: day(0), refunded: false, periods: [{ start: day(0), end: day(20), subscription: 'sub_other' }] },
  ]
  const c = (ends: { at: number; subscription?: string | null }[], d: number) => coverageAt({ payments, ends, cutoff: day(100) }, day(d))
  assert.equal(c([{ at: day(5), subscription: 'sub_other' }], 10), 'covered', 'the review case: deleting sub_other does not end sub_MULTI')
  assert.equal(c([{ at: day(5), subscription: 'sub_MULTI' }], 10), 'covered', 'deleting sub_MULTI leaves sub_other\'s period (to day 20)')
  assert.equal(c([{ at: day(5), subscription: 'sub_MULTI' }], 25), 'unknown', 'after sub_other\'s period ran out, sub_other never ended: unknown')
  assert.equal(c([{ at: day(5), subscription: 'sub_MULTI' }, { at: day(6), subscription: 'sub_other' }], 10), 'not_covered', 'both deleted: the matching end policy applies to each')
  assert.equal(c([{ at: day(5) }], 10), 'not_covered', 'an end naming no subscription stops all of them')
  // a period that names no subscription is stopped by any end: missing identity never invents coverage
  const anon = { payments: [{ at: day(0), refunded: false, periods: [{ start: day(0), end: day(30) }] }], ends: [{ at: day(5), subscription: 'sub_x' }], cutoff: day(100) }
  assert.equal(coverageAt(anon, day(10)), 'not_covered')
  // day-30 retention: only an end of a subscription the first payment was for counts as ended by day 30
  const r = (endSub: string) => retention({ payments: [
    { at: day(0), refunded: false, periods: [{ start: day(0), end: day(30), subscription: 'sub_MULTI' }] },
    { at: day(30), refunded: false, periods: [{ start: day(30), end: day(60), subscription: 'sub_MULTI' }] },
  ], ends: [{ at: day(10), subscription: endSub }], cutoff: day(40) }).day30.retained
  assert.equal(r('sub_other'), true, 'another subscription ending is not this one ending'); assert.equal(r('sub_MULTI'), false)
})

test('day 30 is scoped to the renewed service: a sibling ending on day 20 does not undo sub_good\'s renewal; ending the renewed one does', () => {
  const firstInvoice = { at: day(0), refunded: false, periods: [{ start: day(0), end: day(30), subscription: 'sub_good' }, { start: day(0), end: day(30), subscription: 'sub_ended' }] }
  const renewal = (sub: string | null) => ({ at: day(30), refunded: false, periods: [{ start: day(30), end: day(60), subscription: sub }] })
  const d30 = (ends: { at: number; subscription?: string | null }[], renew: string | null = 'sub_good') =>
    retention({ payments: [firstInvoice, renewal(renew)], ends, cutoff: day(40) })
  // the review case: sub_ended ends on day 20, sub_good renews on day 30 and covers the report date
  const mixed = d30([{ at: day(20), subscription: 'sub_ended' }])
  assert.equal(mixed.day30.retained, true, 'the sibling ending does not undo the continuing service'); assert.equal(mixed.day30.renewal_at, day(30))
  assert.equal(mixed.coverage_at_cutoff, 'covered')
  // matching-service controls
  assert.equal(d30([{ at: day(20), subscription: 'sub_good' }]).day30.retained, false, 'the renewed subscription itself ended by day 30')
  assert.equal(d30([{ at: day(30), subscription: 'sub_good' }]).day30.retained, false, 'ended exactly at day 30')
  assert.equal(d30([{ at: day(31), subscription: 'sub_good' }]).day30.retained, true, 'ended after day 30: day-30 retention holds')
  assert.equal(d30([{ at: day(20), subscription: 'sub_ended' }, { at: day(25), subscription: 'sub_good' }]).day30.retained, false, 'both ended by day 30')
  assert.equal(d30([{ at: day(20) }]).day30.retained, false, 'an end naming no subscription stops all of them')
  // the only renewal is for the subscription that ended: not retained
  assert.equal(d30([{ at: day(20), subscription: 'sub_ended' }], 'sub_ended').day30.retained, false)
  // a renewal with no subscription identity is stopped by any end by day 30
  assert.equal(d30([{ at: day(20), subscription: 'sub_ended' }], null).day30.retained, false)
  // missing identity is conservative: with no end at all, an unidentified renewal still cannot show continuity
  assert.deepEqual([d30([], null).day30.retained, d30([], null).day30.outcome], [false, 'unverified'])
})

test('a new subscription is not retention: day 30 needs continuity with a first-paid service', () => {
  const svc = (d: number, sub: string | null) => ({ at: day(d), refunded: false, periods: [{ start: day(d), end: day(d + 30), subscription: sub }] })
  const d30 = (payments: ReturnType<typeof svc>[], ends: { at: number; subscription?: string | null }[]) => retention({ payments, ends, cutoff: day(40) }).day30
  // Instinct's case: the original service paid on day 0 and ended on day 20; a completely new subscription first paid on day 30
  assert.deepEqual(d30([svc(0, 'sub_orig'), svc(30, 'sub_new')], [{ at: day(20), subscription: 'sub_orig' }]),
    { eligible: true, retained: false, renewal_at: null, outcome: 'new_service' })
  // a new subscription in the window with the original still running and not renewed: still not a renewal
  assert.equal(d30([svc(0, 'sub_orig'), svc(30, 'sub_new')], []).outcome, 'new_service')
  // the same subscription restarted after it ended by day 30 (a rejoin): not retention either
  assert.deepEqual([d30([svc(0, 'sub_orig'), svc(30, 'sub_orig')], [{ at: day(20), subscription: 'sub_orig' }]).retained, d30([svc(0, 'sub_orig'), svc(30, 'sub_orig')], [{ at: day(20), subscription: 'sub_orig' }]).outcome], [false, 'new_service'])
  // missing identity on the first invoice: continuity cannot be shown
  assert.equal(d30([svc(0, null), svc(30, 'sub_new')], []).outcome, 'unverified')
  // positives: the first-paid service renews; a continuing sibling renews while the other first-paid one ended
  assert.deepEqual(d30([svc(0, 'sub_orig'), svc(30, 'sub_orig')], []), { eligible: true, retained: true, renewal_at: day(30), outcome: 'renewed' })
  const both = { at: day(0), refunded: false, periods: [{ start: day(0), end: day(30), subscription: 'sub_a' }, { start: day(0), end: day(30), subscription: 'sub_b' }] }
  assert.equal(retention({ payments: [both, svc(30, 'sub_b')], ends: [{ at: day(20), subscription: 'sub_a' }], cutoff: day(40) }).day30.outcome, 'renewed')
  // nothing paid in the window
  assert.equal(d30([svc(0, 'sub_orig')], []).outcome, 'none')
  assert.equal(retention({ payments: [svc(0, 'sub_orig')], ends: [], cutoff: day(10) }).day30.outcome, null, 'not eligible yet')
})
