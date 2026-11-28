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
    const forbidden = kind === 'hiring' ? ['hiring', 'hire_made'] : [kind]   // a shrinking hire must not become a completed hire either
    const positive = conds.filter(c => !c.negated && forbidden.includes(c.cond.kind))
    assert.equal(positive.length, 0, `"${q}" compiled a POSITIVE ${positive.map(c => c.cond.kind).join('/')} condition: ${positive.map(c => c.cond.text).join('; ')}`)
    const negated = conds.some(c => c.negated && c.cond.kind === kind)
    assert.ok(negated || p.ambiguities.length > 0, `"${q}" produced neither a negated ${kind} condition nor a refusal - it would be read broadly`)
  })
}

// CodeRabbit on #1850: three wordings the grammar rule got wrong. Each is a control for one of the fixes, and the affirmative
// twin of the double negation is here too, so a fix that simply stopped reading negation cannot pass.
const CODE_REVIEW: [string, number, string][] = [
  ['hiring SDRs on hold for now', 1, 'the hold marker must end the role even when text follows it'],
  ['companies that never stopped actively hiring SDRs', 0, 'a modifier between the two negations is still a double negation'],
  ['companies that stopped actively hiring SDRs', 1, 'the same sentence without "never" is a stopped hire'],
  ['companies that hired no fewer than ten SDRs', 0, 'a lower bound states an affirmative hire, not a shrinking one'],
]
for (const [q, wantNegated, why] of CODE_REVIEW) {
  test(`#1163 review "${q}": ${why}`, () => {
    const p = compileTargeting(q)
    const hiring = planConditions(p.root).filter(c => c.cond.kind === 'hiring' || c.cond.kind === 'hire_made')
    assert.equal(hiring.filter(c => !c.negated).length, wantNegated === 0 ? 1 : 0, `"${q}": positive hiring conditions: ${JSON.stringify(hiring.map(c => [c.cond.kind, c.negated]))}`)
    assert.equal(hiring.filter(c => c.negated).length, wantNegated, `"${q}": negated hiring conditions: ${JSON.stringify(hiring.map(c => [c.cond.kind, c.negated]))}`)
  })
}

// Generalisation: the rule reads grammar, so wordings from other industries and other verbs behave the same way without being listed.
// None of these appeared in the issue; each is written the way a person would type a Leads search.
const OTHER_INDUSTRIES: [string, string][] = [
  ['a logistics company that suspended warehouse hiring', 'hiring'],
  ['a law practice that halted hiring associates', 'hiring'],
  ['an hvac contractor that shelved its field hiring', 'hiring'],
  ['a restaurant group that abandoned hiring for the season', 'hiring'],
  ['an accounting firm that cut its graduate hiring', 'hiring'],
  ['a manufacturer that reduced hiring on the night shift', 'hiring'],
  ['a saas startup that turned down venture funding', 'funding'],
  ['a dental group short of funding', 'funding'],
  ['a wholesaler lacking funding for new depots', 'funding'],
  ['a cleaning company that slashed its marketing hiring', 'hiring'],
  ['a fintech that lost its seed funding', 'funding'],
  ['a construction firm that dropped hiring apprentices', 'hiring'],
]

for (const [q, kind] of OTHER_INDUSTRIES) {
  test(`#1163 general rule: "${q}" never compiles ${kind} positive`, () => {
    const p = compileTargeting(q)
    const conds = planConditions(p.root)
    assert.equal(conds.filter(c => !c.negated && c.cond.kind === kind).length, 0, `"${q}" compiled a POSITIVE ${kind} condition`)
    // a wording the compiler reads as no condition at all is also safe (nothing is searched for); what must never happen is the positive
    assert.ok(conds.some(c => c.negated && c.cond.kind === kind) || p.ambiguities.length > 0 || conds.length === 0, `"${q}" compiled the condition positive somewhere else`)
  })
}

// Positive control: the same grammar must not silence an ordinary request, and a doubly negated one is still affirmative.
const AFFIRMATIVE: [string, string][] = [
  ['a dental clinic hiring a receptionist', 'hiring'],
  ['a logistics firm that raised a series b', 'funding'],
  ['a law practice recruiting a paralegal', 'hiring'],
  ['an hvac company hiring two installers', 'hiring'],
  ['a clinic that never stopped hiring hygienists', 'hiring'],
]

for (const [q, kind] of AFFIRMATIVE) {
  test(`#1163 positive control: "${q}" still compiles ${kind} positive`, () => {
    const p = compileTargeting(q)
    const conds = planConditions(p.root)
    const positive = conds.filter(c => !c.negated && c.cond.kind === kind)
    assert.ok(positive.length > 0, `"${q}" lost its ${kind} condition; compiled: ${conds.map(c => c.cond.kind + (c.negated ? ' [NEG]' : '')).join(', ') || 'none'}`)
  })
}

