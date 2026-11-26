// #1163: negated, stopped and shrunken signal wordings must never compile to a POSITIVE condition.
// Each wording from the issue, typed as a Leads search, either compiles to a negated condition or is
// refused as ambiguous - never a positive hiring/funding condition. Generic grammar lexicon, no
// industry word lists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, planConditions } from '../lib/scan/targeting.ts'

const CASES: [string, string][] = [
  ['Business rejecting venture capital funding', 'funding'],
  ['companies that stopped hiring SDRs', 'hiring'],
  ["a dental clinic that isn't hiring a receptionist", 'hiring'],
  ['clinics instead of hiring front-desk staff', 'hiring'],
  ['hiring SDRs on hold', 'hiring'],
  ['startups that lost funding', 'funding'],
  ['startups whose funding fell through', 'funding'],
  ['companies that ran out of funding', 'funding'],
  ['startups yet to raise funding', 'funding'],
  ['pre-funding startups', 'funding'],
  ['companies that hired fewer SDRs', 'hiring'],
  ['agencies barely hiring', 'hiring'],
]

for (const [q, kind] of CASES) {
  test(`#1163 "${q}" never compiles ${kind} positive`, () => {
    const p = compileTargeting(q)
    const conds = planConditions(p.root)
    const positive = conds.filter(c => !c.negated && c.cond.kind === kind)
    assert.equal(positive.length, 0, `"${q}" compiled a POSITIVE ${kind} condition: ${positive.map(c => c.cond.text).join('; ')}`)
    const negated = conds.some(c => c.negated && c.cond.kind === kind)
    assert.ok(negated || p.ambiguities.length > 0, `"${q}" produced neither a negated ${kind} condition nor a refusal - it would be read broadly`)
  })
}
