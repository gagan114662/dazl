// #1163: negated, stopped and shrinking wordings around a funding / hiring / hire condition never compile to a POSITIVE condition.
// Each wording either compiles to a negated condition or to no condition of that kind. Pure compiler test: no network, no model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, planConditions } from '../lib/scan/targeting.ts'

const positive = (q: string) => planConditions(compileTargeting(q).root).filter(x => !x.negated && ['funding', 'hiring', 'hire_made'].includes(x.cond.kind)).map(x => `${x.cond.kind}:${x.cond.text}`)

const WORDINGS = [
  // issue body
  'Business rejecting venture capital funding',
  'stopped hiring SDRs', "isn't hiring a receptionist", 'instead of hiring front-desk staff', 'hiring SDRs on hold',
  'lost funding', 'funding fell through', 'ran out of funding', 'yet to raise funding', 'pre-funding',
  'hired fewer SDRs', 'barely hiring',
  // review comment 1
  ...['postponed', 'delayed', 'shelved', 'scrapped', 'abandoned', 'discontinued', 'terminated', 'is unlikely', 'is off the table', 'is over'].map(w => `hiring SDRs ${w}`),
  ...['slowdown', 'moratorium', 'ban', 'cap', 'cutbacks', 'restrictions', 'down 30%'].map(w => `hiring ${w}`),
  'hired SDRs and fired them', 'hired SDRs then let them go', 'backed out of hiring SDRs',
  // review comment 2
  'hiring ban in place', 'hiring slowdown across the practice',
  ...['slump', 'hiatus', 'stoppage', 'shutdown', 'crunch', 'crisis', 'stall', 'stalls', 'rumours', 'rumors', 'denial', 'withdrawn'].map(w => `hiring ${w}`),
  ...['on ice', 'put on ice', 'in doubt', 'doubtful', 'uncertain', 'under review', 'in limbo', 'at risk', 'a mistake', 'unaffordable', 'proves futile', 'backfires', 'fizzles', 'going badly', 'withdrawn', 'gone', 'rumour', 'maybe'].map(w => `hiring SDRs ${w}`),
  'hiring office manager role withdrawn',
  'Series A rumoured', 'Series A denied', 'funding round rumored', 'funding ban', 'funding slowdown', 'funding talks collapsed', 'funding round pulled', 'funding dried up',
]

for (const w of WORDINGS) test(`#1163 "${w}" compiles to no positive condition`, () => {
  assert.deepEqual(positive(w), [])
})

test('#1163 ordinary positive requests still compile positive (no over-reach)', () => {
  assert.deepEqual(positive('B2B SaaS startups that raised funding and are hiring account executives').map(s => s.split(':')[0]), ['funding', 'hiring'])
  assert.deepEqual(positive('companies that lost a CEO and raised a seed round').map(s => s.split(':')[0]), ['funding'])
  for (const r of ['hiring a registered dental hygienist', 'hiring a licensed practical nurse', 'hiring 3 SDRs', 'hiring experienced SDRs', 'hired their first VP of Sales', 'VC-backed startups'])
    assert.equal(positive(r).length, 1, r)
})

test('#1163 a stopped hiring condition keeps a clean role and records the reading', () => {
  const p = compileTargeting('hiring SDRs postponed')
  const [c] = planConditions(p.root)
  assert.equal(c.negated, true); assert.equal(c.cond.role, 'SDRs')
  assert.ok(p.ambiguities.some(a => /postponed/.test(a.text)))
})
