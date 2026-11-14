// #878 (matrix chicago-law, 2026-11-14): a dated, proven press release stayed "targeting not proven" because the request's clause "expanded a
// practice group" was only read from the literal verb "expand". The quotes below are the real stored quotes of three law-firm releases the matrix
// cited (company names are the public firms' own; nothing else is kept). Pure proof tests: no network, no model, no provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, evaluatePlan, planConditions } from '../lib/scan/targeting.ts'
import { conditionProof, type ProofLead } from '../lib/scan/targeting-proof.ts'

const NOW = Date.parse('2026-11-14T12:00:00Z')
const ctx = { query: 'x', icp: null, salesGatePassed: false, competitors: null, now: NOW }
const QUERY = 'Law firms in Chicago, Illinois that opened a new office or expanded a practice group in the last 90 days'
const plan = compileTargeting(QUERY)
const [open, expand] = planConditions(plan.root).map(x => x.cond)
const lead = (company: string, quote: string, date: string | null = '2026-09-30'): ProofLead => ({ company, company_domain: null, evidence_excerpt: quote, signal: null, source_url: 'https://firm.example/news/x', event_date: date })
const truth = (company: string, quote: string, date: string | null = '2026-09-30') => conditionProof(expand, lead(company, quote, date), [], ctx).truth

const ARMSTRONG = "Armstrong Teasdale is continuing to grow its Corporate Services Group's Chicago presence with the addition of Partner Tracy Jacobson and Counsel Jason Faust."
const MCGUIRE = 'McGuireWoods continues the expansion of its nationally ranked Insurance Recovery Practice Group with the arrival of partner Andrew M. Barrios,'
const BENESCH = 'Benesch is pleased to announce that Michael Chu has joined the firm as a partner in its growing Intellectual Property Practice Group in Chicago.'

test('the plan: C2 is an expand event with no named object, on a 90-day clock', () => {
  assert.deepEqual([open.event, open.object, expand.event, expand.object || '', expand.within_days], ['open', 'office', 'expand', '', 90])
})

test('real releases that word an expansion without the verb pass the expand clause, dated on the lead\'s own day', () => {
  for (const [co, q] of [['Armstrong Teasdale', ARMSTRONG], ['McGuireWoods', MCGUIRE], ['Benesch', BENESCH]] as const) {
    const p = conditionProof(expand, lead(co, q), [], ctx)
    assert.equal(p.truth, 'pass', q)
    assert.equal(p.date, '2026-09-30')
  }
  // and the whole plan (open OR expand) passes for the lead
  const proofs = Object.fromEntries([open, expand].map(c => [c.id, conditionProof(c, lead('Armstrong Teasdale', ARMSTRONG), [], ctx)]))
  assert.equal(evaluatePlan(plan, proofs).truth, 'pass')
})

test('the clock still decides: undated or outside the window stays unknown', () => {
  assert.equal(truth('Armstrong Teasdale', ARMSTRONG, null), 'unknown')
  assert.equal(truth('Armstrong Teasdale', ARMSTRONG, '2026-05-01'), 'unknown')
})

test('not this company, planned, denied, conditional or not growth: unknown', () => {
  assert.equal(truth('Embedd', ARMSTRONG), 'unknown', 'another company is the subject')
  assert.equal(truth('Embedd', BENESCH), 'unknown', 'the clause names another firm')
  for (const q of [
    'Armstrong Teasdale plans to grow its Corporate Services Group in Chicago.',
    'Armstrong Teasdale will bolster its litigation team next year.',
    'Armstrong Teasdale did not grow its Chicago team.',
    'Armstrong Teasdale may strengthen its Chicago presence.',
    'Armstrong Teasdale grows its revenue by 10 percent.',
    'Armstrong Teasdale thanked its Chicago team.',
    'A rival said Armstrong Teasdale reportedly grew its Chicago office.',
    'Michael Chu has joined Armstrong Teasdale as a partner in its Intellectual Property Practice Group.',   // a hire alone, no growth stated
  ]) assert.equal(truth('Armstrong Teasdale', q), 'unknown', q)
})

test('an expand clause that names an object still needs the literal reader', () => {
  const p = compileTargeting('Law firms that expanded into Europe in the last 90 days')
  const c = planConditions(p.root).map(x => x.cond).find(x => x.event === 'expand')!
  assert.ok(c.object, 'the request names where')
  assert.equal(conditionProof(c, lead('Armstrong Teasdale', ARMSTRONG), [], ctx).truth, 'unknown')
})
