import test from 'node:test'
import assert from 'node:assert/strict'
import { customerState, cohortReport, DAY, type LifecycleEvent } from '../lib/gtm/lifecycle.ts'

// Synthetic customers and identities only.
const T0 = Date.UTC(2026, 6, 1)
let n = 0
const at = (d: number) => T0 + d * DAY
const ev = (customer: string, d: number, e: Record<string, unknown>) => ({ id: `e${++n}`, at: at(d), customer, ...e }) as LifecycleEvent
const signup = (c: string, d: number, over: Record<string, unknown> = {}) => ev(c, d, { kind: 'signup', viaTaggedLink: false, consented: false, identity: `${c}@co.test`, ...over })
const touch = (c: string, d: number) => ev(c, d, { kind: 'touch', channel: 'email', identity: `${c}@co.test` })
const run = (c: string, d: number, usableLeads: number) => ev(c, d, { kind: 'run', status: 'done', usableLeads })
const pay = (c: string, d: number, status = 'paid') => ev(c, d, { kind: 'payment', status })

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

test('distinct outcomes: abandoned setup, zero results, activation, repeat, failed payment, refund, churn, retention', () => {
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
    ['ret', [signup('ret', 1), run('ret', 2, 2), pay('ret', 3)], 'retained'],
    ['recovered', [signup('recovered', 1), run('recovered', 2, 2), pay('recovered', 3, 'failed'), pay('recovered', 4)], 'retained'],
  ]
  for (const [c, es, stage] of cases) assert.equal(customerState(c, es, now).stage, stage, c)
  assert.equal(customerState('young', [signup('young', 198)], now).stage, 'signed_up')
  assert.equal(customerState('paid-young', [signup('paid-young', 190), pay('paid-young', 195)], now).stage, 'paid')
  assert.equal(customerState('q', [ev('q', 0, { kind: 'conversation', qualified: true })], now).stage, 'qualified')
  // a key entered or a scan started is not activation
  assert.equal(customerState('k', [signup('k', 1), ev('k', 1, { kind: 'setup', step: 'key' })], now).activatedAt, null)
})

test('report: rates, cost per activated and per retained paying customer, coverage, maturity; synthetic/staging excluded', () => {
  const es = [
    touch('a', 0), signup('a', 1, { viaTaggedLink: true, consented: true }), run('a', 2, 3), pay('a', 3), ev('a', 0, { kind: 'cost', usd: 6, what: 'research' }),
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
  assert.equal(cohortReport(es, meta, at(0), at(30), at(60)).mature, false)
  assert.equal(cohortReport([], [], at(0), at(30), at(60)).activationRate, null)
})
