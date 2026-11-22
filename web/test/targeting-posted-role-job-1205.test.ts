// #1205 (Quest live check, prod 383ada0a, job 5a0d05aee78d4a66fc241f15): "independent dental practices in London, Ontario that posted a front
// desk receptionist job in the past 90 days" was not compiled as a plan hiring condition (the plan view said "no trigger or exclusion it can
// check"), so the run had no hiring condition to search or prove. "posted a job for a receptionist" was read; the role BEFORE the job word was
// not. Pure function: no HTTP, no model, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, planConditions } from '../lib/scan/targeting.ts'

const LIVE = 'independent dental practices in London, Ontario that posted a front desk receptionist job in the past 90 days'

test('#1205 the live request compiles to an open-role condition for its role, with its own 90-day window', () => {
  const plan = compileTargeting(LIVE, null)
  assert.ok(plan.root, 'the plan has a condition')
  const conds = planConditions(plan.root).map(x => x.cond)
  assert.equal(conds.length, 1)
  assert.equal(conds[0].kind, 'hiring')
  assert.equal(conds[0].role, 'front desk receptionist')
  assert.equal(conds[0].within_days, 90)
  assert.notEqual(conds[0].window_source, 'default', 'the window is the one the request states')
})

test('#1205 other "posted a <role> job" shapes read the same; the existing "posted a job for <role>" reading is unchanged', () => {
  for (const [q, role] of [
    ['B2B SaaS startups that posted a sales development representative job in the last 30 days', 'sales development representative'],
    ['Agencies in Toronto that posted an account executive role this month', 'account executive'],
    ['Clinics advertising a dental hygienist position', 'dental hygienist'],
    ['Dental practices that posted a job for a receptionist in the past 60 days', 'receptionist'],
  ] as const) {
    const conds = planConditions(compileTargeting(q, null).root).map(x => x.cond)
    assert.equal(conds.length, 1, q); assert.equal(conds[0].kind, 'hiring', q); assert.equal(conds[0].role, role, q)
  }
})

test('#1205 a post that is not a job is never read as hiring', () => {
  for (const q of [
    'Dental practices that posted a blog article in the past 90 days',
    'Law firms that posted a position paper on AI this year',
    'Startups that posted a new product video',
  ]) assert.ok(!planConditions(compileTargeting(q, null).root).some(x => x.cond.kind === 'hiring'), q)
})
