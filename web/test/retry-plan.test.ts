// Offline planner tests (pure function, no network, no model, no spend). It only DECIDES whether one more search round is
// warranted and with which queries. It never runs a search, never changes the user's query, profile or geography, never
// touches the verifier, and a retried round still goes through every existing gate. Fixture: the observed live Ohio
// baseline (job 7f69533e: 3 queries, 2 hits, 0 verified, one needs_review lead from a login-walled facebook.com post).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRetry, type RetryAttempt } from '../lib/scan/retry-plan.ts'

const QUERY = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job, or publicly complain about their payroll software'
const ICP = { signals: ['Recently posted payroll manager job', 'Recently posted HR manager job', 'Recently posted office manager job', 'Public complaints about payroll software'], where: ['Ohio'] }
const BASE: RetryAttempt = {
  index: 0, verified: 0, hitsUniqueUrls: 2, dropReasons: {},
  queries: ['Ohio company "payroll manager" OR "HR manager" OR "office manager" job posting 10-100 employees', 'Ohio "frustrated with payroll" OR "payroll software problems" OR "payroll system issues"', 'Ohio "payroll manager" OR "HR manager" hiring 10-100 employees'],
  review: [{ reason: 'blocked_by_site', url: 'https://www.facebook.com/marionwatch43302/posts/payroll-glitches/1281037407396094/' }],
}

test('observed baseline: one retry round, new queries, same geography, blocked host excluded, nothing invented', () => {
  const p = planRetry(QUERY, ICP, BASE)
  assert.equal(p.retry, true, p.why)
  assert.ok(p.queries.length >= 1 && p.queries.length <= 3)
  const prior = new Set(BASE.queries.map(q => q.toLowerCase()))
  for (const q of p.queries) {
    assert.ok(!prior.has(q.toLowerCase()), `repeats a prior query: ${q}`)
    assert.match(q, /ohio/i, `geography lost: ${q}`)
    assert.doesNotMatch(q, /(?<!-)site:/i, `no positive site: target: ${q}`)
    assert.ok(q.length <= 300)
  }
  assert.deepEqual(p.excludeHosts, ['www.facebook.com'])
})

test('no retry when 5 or more are verified (needs_review does not count toward it)', () => {
  assert.equal(planRetry(QUERY, ICP, { ...BASE, verified: 5 }).retry, false)
  assert.equal(planRetry(QUERY, ICP, { ...BASE, verified: 4, review: [] }).retry, true)
  assert.equal(planRetry(QUERY, ICP, { ...BASE, verified: 0, review: Array.from({ length: 9 }, (_, i) => ({ reason: 'quote_unconfirmed', url: `https://x.example/${i}` })) }).retry, true, 'nine review leads are still 0 verified')
})

test('at most ONE retry round: a second attempt never plans another', () => {
  assert.equal(planRetry(QUERY, ICP, { ...BASE, index: 1 }).retry, false)
})

test('no retry when there is nothing new to ask (every signal already used) or no signal to build from', () => {
  const used = { ...BASE, queries: ICP.signals.map(s => `${s} Ohio`) }
  assert.equal(planRetry(QUERY, ICP, used).retry, false)
  assert.equal(planRetry(QUERY, { signals: [], where: ['Ohio'] }, BASE).retry, false)
})

test('only login-walled/blocked review rows add excluded hosts; other review reasons and malformed urls add none', () => {
  const a: RetryAttempt = { ...BASE, review: [{ reason: 'quote_unconfirmed', url: 'https://good.example/a' }, { reason: 'login_required', url: 'https://www.linkedin.com/posts/x' }, { reason: 'blocked_by_site', url: 'not a url' }] }
  assert.deepEqual(planRetry(QUERY, ICP, a).excludeHosts, ['www.linkedin.com'])
})
