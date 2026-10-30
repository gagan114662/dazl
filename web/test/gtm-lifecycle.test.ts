import test from 'node:test'
import assert from 'node:assert/strict'
import { customerState, cohortReport, DAY, type LifecycleEvent } from '../lib/gtm/lifecycle.ts'
import { RETENTION } from '../lib/growth/retention.ts'

const H = RETENTION.headline_days, E = RETENTION.renewal_early_days, L = RETENTION.renewal_late_days

// Synthetic customers and identities only.
const T0 = Date.UTC(2026, 6, 1)
let n = 0
const at = (d: number) => T0 + d * DAY
const ev = (customer: string, d: number, e: Record<string, unknown>) => ({ id: `e${++n}`, at: at(d), customer, ...e }) as LifecycleEvent
const signup = (c: string, d: number, over: Record<string, unknown> = {}) => ev(c, d, { kind: 'signup', viaTaggedLink: false, consented: false, identity: `${c}@co.test`, ...over })
const touch = (c: string, d: number) => ev(c, d, { kind: 'touch', channel: 'email', identity: `${c}@co.test` })
const run = (c: string, d: number, usableLeads: number) => ev(c, d, { kind: 'run', status: 'done', usableLeads })
// a paid payment bills a 30-day service period from its date, as a monthly invoice line would (a one-off has none)
const pay = (c: string, d: number, status = 'paid', days: number | null = 30) => ev(c, d, { kind: 'payment', status, ...(status === 'paid' && days !== null ? { periods: [{ start: at(d), end: at(d + days), subscription: `sub_${c}` }] } : {}) })
// a successful monthly payment from day `from` up to and including day `to`
const monthly = (c: string, from: number, to: number) => Array.from({ length: Math.floor((to - from) / 30) + 1 }, (_, i) => pay(c, from + i * 30))

test('counted once: repeated visits, messages and plays for one customer are one customer; replayed events do not double', () => {
  const es = [touch('a', 0), touch('a', 1), touch('a', 2), signup('a', 3, { viaTaggedLink: true, consented: true }), run('a', 4, 3)]
  const r = cohortReport([...es, ...es], [], at(0), at(30), at(200))
  assert.equal(r.customers, 1)
  assert.equal(r.byAttribution.direct, 1)
  assert.equal(customerState('a', [...es, ...es], at(200)).usefulRuns, 1)
})

test('attribution: unrelated signup stays unknown; touch without consented tagged link is only assisted; tag alone is not credit', () => {
  assert.equal(customerState('u', [signup('u', 1, { viaTaggedLink: true, consented: true })], at(5)).attribution, 'unknown')
  assert.equal(customerState('s', [touch('s', 0), signup('s', 1)], at(5)).attribution, 'assisted')
  // a touch to a different identity does not match
  const other = [ev('o', 0, { kind: 'touch', channel: 'email', identity: 'someone-else@co.test' }), signup('o', 1, { viaTaggedLink: true, consented: true })]
  assert.equal(customerState('o', other, at(5)).attribution, 'unknown')
  // a touch after the signup cannot have led to it
  assert.equal(customerState('l', [signup('l', 1), touch('l', 2)], at(5)).attribution, 'unknown')
})

test('distinct outcomes: abandoned setup, zero results, activation, repeat, failed payment, refund, churn, not retained, retention', () => {
  const now = at(200)
  const cases: [string, LifecycleEvent[], string][] = [
    ['ab', [signup('ab', 1), ev('ab', 1, { kind: 'setup', step: 'key' }), ev('ab', 2, { kind: 'run', status: 'failed', usableLeads: 0 })], 'abandoned_setup'],
    ['z', [signup('z', 1), run('z', 2, 0)], 'zero_result'],
    ['act', [signup('act', 1), run('act', 2, 0), run('act', 3, 2)], 'activated'],
    ['same-day', [signup('same-day', 1), run('same-day', 2, 2), ev('same-day', 2.01, { kind: 'run', status: 'done', usableLeads: 1 })], 'activated'],
    ['rep', [signup('rep', 1), run('rep', 2, 2), run('rep', 9, 1)], 'repeat'],
    ['pf', [signup('pf', 1), run('pf', 2, 2), pay('pf', 3, 'failed')], 'payment_failed'],
    ['rf', [signup('rf', 1), run('rf', 2, 2), pay('rf', 3), pay('rf', 5, 'refunded')], 'refunded'],
    ['ch', [signup('ch', 1), run('ch', 2, 2), pay('ch', 3), ev('ch', 40, { kind: 'cancel' })], 'churned'],
    ['ret', [signup('ret', 1), run('ret', 2, 2), ...monthly('ret', 3, 183)], 'retained'],
    ['recovered', [signup('recovered', 1), run('recovered', 2, 2), pay('recovered', 3, 'failed'), ...monthly('recovered', 4, 184)], 'retained'],
  ]
  for (const [c, es, stage] of cases) assert.equal(customerState(c, es, now).stage, stage, c)
  assert.equal(customerState('young', [signup('young', 198)], now).stage, 'signed_up')
  assert.equal(customerState('paid-young', [signup('paid-young', 190), pay('paid-young', 195)], now).stage, 'paid')
  assert.equal(customerState('late-renewal', [signup('late-renewal', 1), ...monthly('late-renewal', 3, 153), pay('late-renewal', 187)], now).stage, 'retained')
  assert.equal(customerState('q', [ev('q', 0, { kind: 'conversation', qualified: true })], now).stage, 'qualified')
  // a key entered or a scan started is not activation
  assert.equal(customerState('k', [signup('k', 1), ev('k', 1, { kind: 'setup', step: 'key' })], now).activatedAt, null)
})

test('report: rates, cost per activated and per retained paying customer, coverage, maturity; synthetic/staging excluded', () => {
  const es = [
    touch('a', 0), signup('a', 1, { viaTaggedLink: true, consented: true }), run('a', 2, 3), ...monthly('a', 3, 183), ev('a', 0, { kind: 'cost', usd: 6, what: 'research' }),
    signup('b', 2), run('b', 3, 1), ev('b', 2, { kind: 'cost', usd: 4, what: 'enrichment' }),
    signup('c', 4), ev('c', 4, { kind: 'cost', usd: 2, what: 'evaluation' }),
    signup('fake', 1), run('fake', 2, 9), pay('fake', 3),
  ]
  const meta = [{ customer: 'fake', synthetic: true, staging: false }]
  const r = cohortReport(es, meta, at(0), at(30), at(200))
  assert.equal(r.customers, 3)
  assert.equal(r.excluded, 1)
  assert.equal(r.activationRate, 2 / 3)
  assert.equal(r.paidRate, 1 / 3)
  assert.equal(r.retention.rate, 1)
  assert.equal(r.costUsd, 12)
  assert.equal(r.costPerActivated, 6)
  assert.equal(r.costPerRetainedPaying, 12)
  assert.equal(r.sourceCoverage, 1 / 3)
  assert.equal(r.mature, true)
  assert.deepEqual(r.byStage, { retained: 1, activated: 1, abandoned_setup: 1 })
  assert.equal(r.retention.label, RETENTION.labels.day30)
  assert.equal(cohortReport(es, meta, at(0), at(30), at(60)).mature, false)
  assert.equal(cohortReport([], [], at(0), at(30), at(60)).activationRate, null)
})

test('one as-of cutoff for every row: future-dated signups, runs, payments and replays never count', () => {
  const now = at(100)
  const es = [
    signup('a', 1), run('a', 2, 2),
    pay('a', 150),                                   // a payment dated after as-of: not paid yet
    run('a', 120, 5),                                // a run dated after as-of: not a repeat
    signup('future', 101), run('future', 102, 3),   // a signup after as-of: not a customer yet
    signup('fake', 150),                             // excluded customer seen only after as-of: not counted as excluded either
  ]
  const s = customerState('a', es, now)
  assert.equal(s.paidAt, null)
  assert.equal(s.usefulRuns, 1)
  assert.equal(s.stage, 'activated')
  const r = cohortReport(es, [{ customer: 'fake', synthetic: true, staging: false }], at(0), at(200), now)
  assert.equal(r.customers, 1)
  assert.equal(r.excluded, 0)
  assert.equal(r.paidRate, 0)
  // A replay of an existing id with a later date cannot displace the original, whichever order the rows arrive in.
  const orig = { id: 'p1', at: at(5), customer: 'r', kind: 'payment', status: 'paid' } as LifecycleEvent
  const late = { ...orig, at: at(150) } as LifecycleEvent
  for (const order of [[orig, late], [late, orig]]) assert.equal(customerState('r', [signup('r', 1), ...order], now).paidAt, at(5))
  // Moving as-of past the rows brings them in.
  assert.equal(customerState('a', es, at(160)).paidAt, at(150))
})

test('shared definitions through this file\'s events: day-30 retention needs a renewal inside its window; coverage is evidence or unknown', () => {
  const now = at(200)
  // Paid once on day 3, nothing since: in the day-30 cohort, not retained; coverage unknown (no end recorded, period ran out).
  const once = customerState('once', [signup('once', 1), run('once', 2, 2), pay('once', 3)], now)
  assert.deepEqual([once.stage, once.retention.day30.eligible, once.retention.day30.retained, once.retention.coverage_at_cutoff], ['not_retained', true, false, 'unknown'])
  // Inside the first month: not in the day-30 cohort yet, but covered now.
  const young = customerState('once', [signup('once', 1), run('once', 2, 2), pay('once', 3)], at(30))
  assert.deepEqual([young.stage, young.retention.day30.eligible, young.retention.day30.retained, young.retention.coverage_at_cutoff], ['paid', false, null, 'covered'])
  // Renewed in the window, cancelled later: retained at day 30, and not covered now.
  const left = customerState('left', [signup('left', 1), pay('left', 3), pay('left', 33), ev('left', 50, { kind: 'cancel' })], now)
  assert.deepEqual([left.stage, left.retention.day30.retained, left.retention.coverage_at_cutoff], ['churned', true, 'not_covered'])
  // Renewed, but the subscription ended by day 30: not retained.
  const early = customerState('early', [signup('early', 1), pay('early', 3), pay('early', 30), ev('early', 32, { kind: 'cancel' })], now)
  assert.equal(early.retention.day30.retained, false)
  // A refunded renewal is no renewal.
  assert.equal(customerState('rf2', [signup('rf2', 1), pay('rf2', 3), pay('rf2', 33), pay('rf2', 34, 'refunded')], now).retention.day30.retained, false)
  // A lapse and a rejoin after the window is not day-30 retention.
  assert.equal(customerState('rejoin', [signup('rejoin', 1), pay('rejoin', 3), pay('rejoin', 60)], now).retention.day30.retained, false)
  // The report carries both metrics, each with its own cohort and label.
  const r = cohortReport([signup('once', 1), pay('once', 3), signup('left', 1), pay('left', 3), pay('left', 33), ev('left', 50, { kind: 'cancel' }), signup('r', 2), ...monthly('r', 4, 184)], [], at(0), at(30), now)
  assert.deepEqual([r.retention.eligible, r.retention.retained, r.retention.rate, r.retention.label], [3, 2, 2 / 3, RETENTION.labels.day30])
  assert.ok(r.retention.cohort.length > 0)
  assert.deepEqual([r.coverage.covered, r.coverage.not_covered, r.coverage.unknown, r.coverage.cohort_size, r.coverage.label], [1, 1, 1, 3, RETENTION.labels.coverage])
  assert.notEqual(r.coverage.cohort, r.retention.cohort)
})

test('shared window and cohort rules at their boundaries, through this file\'s events', () => {
  const S = 1000  // one second, the shared module's resolution
  const at1 = (c: string, t: number) => ({ id: `${c}-${t}`, at: t, customer: c, kind: 'payment', status: 'paid', periods: [{ start: t, end: t + 30 * DAY, subscription: `sub_${c}` }] }) as LifecycleEvent
  const renewedAt = (c: string, t: number) => customerState(c, [signup(c, 0), pay(c, 0), at1(c, t)], at(100)).retention.day30.retained
  // The renewal window is [H - E, H + L] days after the first payment, both ends included.
  assert.equal(renewedAt('w1', at(H - E)), true)
  assert.equal(renewedAt('w2', at(H - E) - S), false)
  assert.equal(renewedAt('w3', at(H + L)), true)
  assert.equal(renewedAt('w4', at(H + L) + S), false)
  // In the day-30 cohort once the window has closed (H + L days), in both numerator and denominator; a second earlier, in neither.
  const es = [signup('b', 0), pay('b', 0), pay('b', H)]
  const before = cohortReport(es, [], at(0), at(30), at(H + L) - S)
  assert.deepEqual([before.retention.eligible, before.retention.retained, before.retention.rate], [0, 0, null])
  const closed = cohortReport(es, [], at(0), at(30), at(H + L))
  assert.deepEqual([closed.retention.eligible, closed.retention.retained, closed.retention.rate], [1, 1, 1])
  // Ending exactly at day 30 counts as ended by day 30; a second later does not.
  const endAt = (c: string, t: number) => [signup(c, 0), pay(c, 0), pay(c, H), { id: `${c}-end`, at: t, customer: c, kind: 'cancel' } as LifecycleEvent]
  assert.equal(customerState('e1', endAt('e1', at(H)), at(100)).retention.day30.retained, false)
  assert.equal(customerState('e2', endAt('e2', at(H) + S), at(100)).retention.day30.retained, true)
})

test('retention rate: numerator and denominator are the same cohort, so renewed-but-young customers cannot push it over 100%', () => {
  const es = [
    signup('im1', 0), pay('im1', 1), pay('im1', 31),
    signup('im2', 0), pay('im2', 1), pay('im2', 31),
    signup('m', 0), pay('m', 0),
  ]
  const im1 = customerState('im1', es, at(H + L))
  assert.deepEqual([im1.stage, im1.retention.day30.eligible, im1.retention.day30.renewal_at], ['paid', false, at(31) / 1000])
  const r = cohortReport(es, [], at(0), at(30), at(H + L))
  assert.deepEqual([r.retention.eligible, r.retention.retained, r.retention.rate, r.costPerRetainedPaying], [1, 0, 0, null])
})

test('coverage through this file\'s events: actual service intervals; an end stops service; a gap is not covered', () => {
  const cov = (es: LifecycleEvent[], d: number) => customerState(es[0].customer, es, at(d)).retention.coverage_at_cutoff
  assert.equal(cov([signup('an', 0), pay('an', 0, 'paid', 365)], 200), 'covered', 'annual')
  assert.equal(cov([signup('on', 0), pay('on', 0, 'paid', null)], 5), 'unknown', 'one-off, no period')
  assert.equal(cov([signup('pr', 0), pay('pr', 10, 'paid', 8)], 20), 'unknown', 'prorated period ran out')
  assert.equal(cov([signup('ic', 0), pay('ic', 0), ev('ic', 5, { kind: 'cancel' })], 10), 'not_covered', 'cancelled on day 5')
  // cancellation at the period end (docs.stripe.com/billing/subscriptions/cancel): not an end until the period ends
  assert.equal(cov([signup('pp', 0), pay('pp', 0)], 10), 'covered', 'scheduled to cancel, still inside the paid period')
  assert.equal(cov([signup('pp2', 0), pay('pp2', 0), ev('pp2', 30, { kind: 'cancel' })], 31), 'not_covered', 'deleted when the period ended')
  // one payment for two periods with a gap: covered inside each, not in the gap
  const gap = [signup('gp', 0), ev('gp', 0, { kind: 'payment', status: 'paid', periods: [{ start: at(0), end: at(10), subscription: 'sub_a' }, { start: at(50), end: at(60), subscription: 'sub_b' }] })]
  assert.deepEqual([cov(gap, 5), cov(gap, 30), cov(gap, 55)], ['covered', 'unknown', 'covered'])
})

test('a cancel ends its own subscription only: deleting sub_other keeps sub_MULTI covered and paying; deleting sub_MULTI too ends the customer', () => {
  const two = (c: string) => [signup(c, 0), run(c, 1, 2), ev(c, 2, { kind: 'payment', status: 'paid', periods: [{ start: at(2), end: at(32), subscription: 'sub_MULTI' }, { start: at(2), end: at(32), subscription: 'sub_other' }] })]
  const one = customerState('m1', [...two('m1'), ev('m1', 5, { kind: 'cancel', subscription: 'sub_other' })], at(10))
  assert.equal(one.retention.coverage_at_cutoff, 'covered'); assert.equal(one.stage, 'paid', 'still a paying customer, not churned')
  const both = customerState('m2', [...two('m2'), ev('m2', 5, { kind: 'cancel', subscription: 'sub_other' }), ev('m2', 6, { kind: 'cancel', subscription: 'sub_MULTI' })], at(10))
  assert.equal(both.retention.coverage_at_cutoff, 'not_covered'); assert.equal(both.stage, 'churned')
})

test('day 30 through this file\'s events: sub_ended cancelled on day 20 does not undo sub_good renewed on day 30; cancelling sub_good does', () => {
  const es = (c: string, cancelSub: string) => [signup(c, 0), run(c, 1, 2),
    ev(c, 2, { kind: 'payment', status: 'paid', periods: [{ start: at(2), end: at(32), subscription: 'sub_good' }, { start: at(2), end: at(32), subscription: 'sub_ended' }] }),
    ev(c, 22, { kind: 'cancel', subscription: cancelSub }),
    ev(c, 32, { kind: 'payment', status: 'paid', periods: [{ start: at(32), end: at(62), subscription: 'sub_good' }] })]
  const mixed = customerState('mx', es('mx', 'sub_ended'), at(45))
  assert.equal(mixed.retention.day30.retained, true); assert.equal(mixed.retention.coverage_at_cutoff, 'covered'); assert.equal(mixed.stage, 'retained')
  const matching = customerState('mm', es('mm', 'sub_good'), at(45))
  assert.equal(matching.retention.day30.retained, false, 'the renewed subscription itself was cancelled by day 30')
})

test('a new subscription in the window is not retention through this file\'s events; a continuing sibling still is', () => {
  const now = at(100)
  const svc = (c: string, d: number, sub: string) => ev(c, d, { id: `${c}-${sub}-${d}`, kind: 'payment', status: 'paid', periods: [{ start: at(d), end: at(d + 30), subscription: sub }] })
  // original service paid on day 0, ended on day 20; a completely new subscription first paid on day 30
  const fresh = customerState('fresh', [signup('fresh', 0), svc('fresh', 0, 'sub_orig'), ev('fresh', 20, { kind: 'cancel', subscription: 'sub_orig' }), svc('fresh', 30, 'sub_new')], now)
  assert.deepEqual([fresh.retention.day30.retained, fresh.retention.day30.outcome], [false, 'new_service'])
  assert.notEqual(fresh.stage, 'retained')
  // two first-paid subscriptions: one ends on day 20, the other renews on day 30 and continues
  const two = ev('sib', 0, { id: 'sib-first', kind: 'payment', status: 'paid', periods: [{ start: at(0), end: at(30), subscription: 'sub_a' }, { start: at(0), end: at(30), subscription: 'sub_b' }] })
  const sib = customerState('sib', [signup('sib', 0), two, ev('sib', 20, { kind: 'cancel', subscription: 'sub_a' }), svc('sib', 30, 'sub_b')], now)
  assert.deepEqual([sib.retention.day30.retained, sib.retention.day30.outcome], [true, 'renewed'])
})
