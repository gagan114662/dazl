// PM call on Qodo #1441 "Returning users lose reviewed exclusions": a returning user who picks a DIFFERENT offer gets a
// fresh buyer profile (the #1436 fix: the earlier play's dental ICP is not used), but every reviewed exclusion of the
// carried profile still applies to the new run - losing one could mean contacting someone the user excluded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { directOfferProfile, directOfferRun } from '../app/app/leads/offer-preflight.ts'
import { carriedExclusions, applyCarriedExclusions, carryStub } from '../lib/scan/carry-exclusions.ts'
import { normalizeIcp, type Icp } from '../lib/scan/icp.ts'

const dental: Icp = { summary: 'Dental practices in Ontario', who: ['practice owner'], industries: ['dental'], sizes: [], where: ['Ontario'], signals: [],
  exclude: ['Acme Dental (acme.example)', 'competitors: Leadrival (leadrival.example)'],
  research: { v: 1, site: 'leadly.example', offers: [{ i: 'o1', n: 'Dental SEO' }], q: null, ans: null, hyps: [
    { i: 'h1', o: 'o1', k: 'disqualifier', t: 'hospital groups', s: 'reviewed', u: null, q: null, at: 1 },
    { i: 'h2', o: 'o1', k: 'disqualifier', t: 'unreviewed guess', s: 'hypothesis', u: null, q: null, at: 1 },
    { i: 'h3', o: 'o1', k: 'industry', t: 'dental', s: 'reviewed', u: null, q: null, at: 1 }] } }

test('a different offer: no carried ICP, but the reviewed exclusions go with the run and are applied', () => {
  const run = directOfferRun('Leadly (leadly.example), AI lead finding', 'Dental SEO', dental)
  assert.equal(run.icp, null, 'dental ICP not used')
  assert.deepEqual(run.carryExclude, ['Acme Dental (acme.example)', 'competitors: Leadrival (leadrival.example)', 'hospital groups'])
  const stub = carryStub(run.carryExclude)!
  assert.equal(normalizeIcp(JSON.parse(stub)), null, 'the stored stub is never mistaken for a profile, so a fresh one is inferred')
  const inferred: Icp = { summary: 'B2B SaaS founders', who: ['founder'], industries: ['saas'], sizes: [], where: [], signals: [], exclude: ['agencies'] }
  const used = applyCarriedExclusions(inferred, stub)
  assert.deepEqual(used.exclude, ['agencies']); assert.deepEqual(used.carry_exclude, ['Acme Dental (acme.example)', 'competitors: Leadrival (leadrival.example)', 'hospital groups'])
  assert.deepEqual(used.industries, ['saas'], 'buyer comes from the new offer only')
})
test('same offer still carries the whole profile; nothing to carry means no stub', () => {
  assert.equal(directOfferProfile('Dental SEO', 'Dental SEO', dental), dental)
  assert.deepEqual(directOfferRun('Dental SEO', 'Dental SEO', dental), { icp: dental, carryExclude: [] })
  assert.equal(carryStub([]), null)
  assert.deepEqual(carriedExclusions(null), [])
  const inferred: Icp = { summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
  assert.equal(applyCarriedExclusions(inferred, null), inferred)
  assert.equal(applyCarriedExclusions(inferred, '{"summary":"real profile"}'), inferred, 'only a carry stub is read')
})

// Qodo on b25aa24 (1-3).
import { carryAdmission, CARRY_JSON_BUDGET } from '../lib/scan/carry-exclusions.ts'
import { carriedExcluded } from '../lib/scan/carry-gate.ts'
import { budgetedIcp, ICP_JSON_BUDGET } from '../lib/scan/icp.ts'

const seven = ['Acme Dental (acme.example)', 'Brightsmile (brightsmile.example)', 'Leadrival (leadrival.example)', 'Pipewell', 'hospital groups', 'Orthoplus (orthoplus.example)', 'Seventh Co (seventh.example)']

test('retry: seven reviewed exclusions survive normalizing the stored profile (not capped at six)', () => {
  const inferred: Icp = { summary: 'B2B SaaS founders', who: ['founder'], industries: ['saas'], sizes: [], where: [], signals: [], exclude: ['agencies'] }
  const first = applyCarriedExclusions(inferred, carryStub(seven))
  const again = normalizeIcp(JSON.parse(JSON.stringify(first)))!   // the retry reads the saved profile back
  assert.deepEqual(again.carry_exclude, seven)
  assert.equal(applyCarriedExclusions(again, JSON.stringify(again)).carry_exclude?.length, 7)
})
test('budget: a carry list that cannot fit is refused at admission with a clear message; one that fits always fits a full profile', () => {
  const huge = Array.from({ length: 40 }, (_, i) => `Excluded company number ${i} with a long description of why (x${i}.example)`)
  const r = carryAdmission(huge)
  assert.equal(r.ok, false); assert.match((r as { error: string }).error, /exclusions/i)
  const ok = carryAdmission(seven); assert.equal(ok.ok, true)
  const near: Icp = { summary: 'x'.repeat(300), who: Array(4).fill('y'.repeat(160)), industries: Array(4).fill('z'.repeat(160)), sizes: [], where: Array(3).fill('w'.repeat(160)), signals: Array(2).fill('s'.repeat(160)), exclude: Array(3).fill('e'.repeat(160)) }
  assert.ok(JSON.stringify(near).length <= ICP_JSON_BUDGET - CARRY_JSON_BUDGET, 'test profile sits under the room left for carried exclusions')
  const merged = applyCarriedExclusions(near, (ok as { stub: string }).stub)
  assert.equal(budgetedIcp(merged).ok, true)
})
test('hard gate: a lead matching a carried exclusion is excluded by code, by domain or by name', () => {
  const icpJson = JSON.stringify({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], carry_exclude: seven })
  assert.equal(carriedExcluded(icpJson, { company: 'Acme Dental Group', company_domain: 'www.acme.example' }), true)
  assert.equal(carriedExcluded(icpJson, { company: 'Pipewell Inc', company_domain: 'pw.example' }), true)
  assert.equal(carriedExcluded(icpJson, { company: 'Northwind', company_domain: 'northwind.example', contact: 'a@seventh.example' }), true)
  assert.equal(carriedExcluded(icpJson, { company: 'Northwind', company_domain: 'northwind.example' }), false)
  assert.equal(carriedExcluded(null, { company: 'Acme Dental' }), false)
})
