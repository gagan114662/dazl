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
  assert.deepEqual(used.exclude, ['agencies', 'Acme Dental (acme.example)', 'competitors: Leadrival (leadrival.example)', 'hospital groups'])
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
