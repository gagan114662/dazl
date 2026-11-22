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
    ['Agencies in Toronto that posted an account executive job this month', 'account executive'],
    ['Clinics advertising a dental hygienist vacancy', 'dental hygienist'],
    ['Dental practices that posted a receptionist job through Indeed', 'receptionist'],
    ['Dental clinics that posted a receptionist job posting in the last 30 days', 'receptionist'],
    ['Companies that posted a job opening for a sales rep last month', 'sales rep'],
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

// council (Sonnet R1/R2): the role is a role. "job opening for a nurse" names the nurse; a phrase with grammar words in it ("a press release
// about a new role") is not a role; a work arrangement ("remote") is an open role with no named title
test('#1205 the role read before the job word is a role, never job words, grammar words or a work arrangement', () => {
  const one = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  const nurse = one('companies that posted a job opening for a nurse')
  assert.equal(nurse.length, 1); assert.equal(nurse[0].role, 'nurse')
  assert.equal(one('companies that posted a press release about a new role in Toronto').length, 0)
  const remote = one('Agencies that posted a remote job in the past 30 days')
  assert.equal(remote.length, 1); assert.equal(remote[0].role, ''); assert.equal(remote[0].within_days, 30)
})

// council (Opus R1/R2, Haiku R1-R3): "opening", "position" and "role" name many things besides a job, so the role-before reading takes only the
// unambiguous job words; ordinary business wording is never a hiring condition, and a negated request stays negated
test('#1205 business wording with opening / position / role is never a hiring condition; the role is never a job word', () => {
  const hiring = (q: string) => planConditions(compileTargeting(q, null).root).filter(x => x.cond.kind === 'hiring')
  for (const q of [
    'Restaurants that posted a grand opening in the past 30 days',
    'Retailers that posted a new office opening this year',
    'Companies that posted a net cash position this quarter',
    'Think tanks that posted a public position on AI',
    'Firms that posted a statement on their role in the merger',
  ]) assert.equal(hiring(q).length, 0, q)
  for (const q of ['Advertising agencies posting senior designer roles in the past 30 days', 'Dental practices advertising their job openings in London, Ontario', 'Advertising firms with an account executive opening'])
    for (const h of hiring(q)) assert.ok(!/^(?:jobs?|agencies|firms)\b/.test(h.cond.role ?? ''), `${q}: role ${h.cond.role}`)
  const neg = planConditions(compileTargeting('Dental practices that have not posted a receptionist job in the past 90 days', null).root)
  assert.equal(neg.length, 1); assert.equal(neg[0].cond.kind, 'hiring'); assert.equal(neg[0].negated, true)
})

// council (Haiku R8/R9): a title with "of" in it is a role; "advertised for a <role> job" is a job advert
test('#1205 titles with "of" and "advertised for a <role> job" are read', () => {
  const one = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  for (const [q, role] of [
    ['Companies that posted a Director of Sales job in the past 90 days', 'Director of Sales'],
    ['Startups that posted a Head of Marketing job in the last 60 days', 'Head of Marketing'],
    ['Dental practices that advertised for a receptionist job in the past 90 days', 'receptionist'],
  ] as const) { const h = one(q); assert.equal(h.length, 1, q); assert.equal(h[0].role, role, q) }
  assert.equal(one('companies that posted a press release about a new role in the past 90 days').length, 0)
  assert.equal(one('Advertising agencies in Toronto that opened a new office').length, 0)
})
