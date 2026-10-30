import test from 'node:test'
import assert from 'node:assert/strict'
import { customerState, cohortReport, DAY, type LifecycleEvent } from '../lib/gtm/lifecycle.ts'
import { RETENTION } from '../lib/growth/retention.ts'

const H = RETENTION.headline_days, G = RETENTION.grace_days

// Synthetic customers and identities only.
const T0 = Date.UTC(2026, 6, 1)
let n = 0
const at = (d: number) => T0 + d * DAY
const ev = (customer: string, d: number, e: Record<string, unknown>) => ({ id: `e${++n}`, at: at(d), customer, ...e }) as LifecycleEvent
const signup = (c: string, d: number, over: Record<string, unknown> = {}) => ev(c, d, { kind: 'signup', viaTaggedLink: false, consented: false, identity: `${c}@co.test`, ...over })
const touch = (c: string, d: number) => ev(c, d, { kind: 'touch', channel: 'email', identity: `${c}@co.test` })
const run = (c: string, d: number, usableLeads: number) => ev(c, d, { kind: 'run', status: 'done', usableLeads })
const pay = (c: string, d: number, status = 'paid') => ev(c, d, { kind: 'payment', status })
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
  assert.equal(r.retentionRate, 1)
  assert.equal(r.costUsd, 12)
  assert.equal(r.costPerActivated, 6)
  assert.equal(r.costPerRetainedPaying, 12)
  assert.equal(r.sourceCoverage, 1 / 3)
  assert.equal(r.mature, true)
  assert.deepEqual(r.byStage, { retained: 1, activated: 1, abandoned_setup: 1 })
  assert.equal(r.retentionLabel, RETENTION.label)
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

test('shared definition: the 30-day headline is renewal plus coverage evidence, and each is reported on its own', () => {
  const now = at(200)
  // Paid once on day 3, nothing since: eligible, no renewal, not retained (an old payment is never retention by itself).
  const once = customerState('once', [signup('once', 1), run('once', 2, 2), pay('once', 3)], now)
  assert.deepEqual([once.stage, once.retention.eligible, once.retention.renewal, once.retention.retained], ['not_retained', true, false, false])
  // Inside the first month: not eligible yet, so neither retained nor not retained.
  const young = customerState('once', [signup('once', 1), run('once', 2, 2), pay('once', 3)], at(30))
  assert.deepEqual([young.stage, young.retention.eligible, young.retention.retained], ['paid', false, null])
  // Renewed, then cancelled after the headline mark: retained at 30 days, but not covered at the cutoff.
  const left = customerState('left', [signup('left', 1), pay('left', 3), pay('left', 33), ev('left', 50, { kind: 'cancel' })], now)
  assert.deepEqual([left.stage, left.retention.retained, left.retention.covered_at_headline, left.retention.covered_at_cutoff], ['churned', true, true, false])
  // Renewed, but the subscription ended by the headline mark: no coverage evidence, not retained.
  const early = customerState('early', [signup('early', 1), pay('early', 3), pay('early', 30), ev('early', 32, { kind: 'cancel' })], now)
  assert.deepEqual([early.retention.renewal, early.retention.covered_at_headline, early.retention.retained], [true, false, false])
  // A refunded renewal is no renewal evidence.
  const rf = customerState('rf2', [signup('rf2', 1), pay('rf2', 3), pay('rf2', 33), pay('rf2', 34, 'refunded')], now)
  assert.deepEqual([rf.retention.renewal, rf.retention.retained], [false, false])
  // The report uses the shared rate and label; current coverage sits beside the headline, not inside it.
  const r = cohortReport([signup('once', 1), pay('once', 3), signup('left', 1), pay('left', 3), pay('left', 33), ev('left', 50, { kind: 'cancel' }), signup('r', 2), ...monthly('r', 4, 184)], [], at(0), at(30), now)
  assert.deepEqual([r.retentionEligible, r.retained, r.retentionRate, r.coveredAtCutoff], [3, 2, 2 / 3, 2])
  assert.equal(r.retentionLabel, RETENTION.label)
})

test('shared grace and maturity rules, at their boundaries', () => {
  const S = 1000  // one second, the shared module's resolution
  // Renewal counts from headline - grace days after the first payment; one second earlier it does not.
  assert.equal(customerState('g1', [signup('g1', 0), pay('g1', 0), ev('g1', H - G, { kind: 'payment', status: 'paid' })], at(100)).retention.renewal, true)
  assert.equal(customerState('g2', [signup('g2', 0), pay('g2', 0), { id: 'g2-early', at: at(H - G) - S, customer: 'g2', kind: 'payment', status: 'paid' } as LifecycleEvent], at(100)).retention.renewal, false)
  // Eligible from headline + grace days after the first payment, in both numerator and denominator; one second earlier, in neither.
  const es = [signup('b', 0), pay('b', 0), pay('b', H)]
  const before = cohortReport(es, [], at(0), at(30), at(H + G) - S)
  assert.deepEqual([before.retentionEligible, before.retained, before.retentionRate], [0, 0, null])
  const onTime = cohortReport(es, [], at(0), at(30), at(H + G))
  assert.deepEqual([onTime.retentionEligible, onTime.retained, onTime.retentionRate], [1, 1, 1])
  // Coverage at the headline: a subscription ending exactly at first payment + headline days is not covered; one second later it is.
  const endAt = (c: string, t: number) => [signup(c, 0), pay(c, 0), pay(c, H), { id: `${c}-end`, at: t, customer: c, kind: 'cancel' } as LifecycleEvent]
  assert.equal(customerState('e1', endAt('e1', at(H)), at(100)).retention.covered_at_headline, false)
  assert.equal(customerState('e2', endAt('e2', at(H) + S), at(100)).retention.covered_at_headline, true)
})

test('retention rate: numerator and denominator are the same eligible set, so renewed-but-young customers cannot push it over 100%', () => {
  const es = [
    signup('im1', 0), pay('im1', 1), pay('im1', 31),
    signup('im2', 0), pay('im2', 1), pay('im2', 31),
    signup('m', 0), pay('m', 0),
  ]
  const im1 = customerState('im1', es, at(H + G))
  assert.deepEqual([im1.stage, im1.retention.renewal, im1.retention.eligible], ['paid', true, false])
  const r = cohortReport(es, [], at(0), at(30), at(H + G))
  assert.deepEqual([r.retentionEligible, r.retained, r.retentionRate, r.costPerRetainedPaying], [1, 0, 0, null])
})
