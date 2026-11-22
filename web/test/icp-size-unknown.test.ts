import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScores, applyIcpGate } from '../lib/scan/score.ts'

// Run 679a7354: Monaco, HowGood, Simple AI graded "match ??n? | mism size unknown" - the model wrote n for a size the evidence never
// states, so the ICP gate capped fit at 1 ("ICP mismatch (size: size unknown)") while its own why said "exact ICP match". Unknown is unknown.
const icp = { summary: 'x', who: ['Founder', 'CEO', 'Head of Sales'], industries: [], sizes: ['5-200 employees'], where: [], signals: [], exclude: [], window_days: 45 } as never
const line = (mism: string) => `LEAD 1 | fit 5 | intent 4 | action 4 | match ??n? | signals none | why Founding SDR posting; this is an exact ICP match. | mism ${mism}`
test('a size "mismatch" whose own note says the size is unknown is unknown, and does not cap fit', () => {
  for (const note of ['size unknown', 'company size not stated', 'headcount unclear', 'size not provided', 'not stated', 'headcount and revenue not stated']) {
    const s = applyIcpGate(parseScores(line(note), 1)!, icp)[0]
    assert.equal(s.match.size, 'unknown', note); assert.equal(s.fit, 5, note); assert.doesNotMatch(s.why, /ICP mismatch/, note)
  }
})
test('a stated size outside the range is still a mismatch and still caps fit', () => {
  for (const note of ['size: 5,000+ employees', 'too large: public company with 12000 staff']) {
    const s = applyIcpGate(parseScores(line(note), 1)!, icp)[0]
    assert.equal(s.match.size, 'mismatch', note); assert.ok(s.fit <= 1, note)
  }
})
test('an unknown cue about another criterion never erases a stated mismatch (Qodo #1516)', () => {
  for (const note of ['too large: public company with 12000 staff; founder not stated', 'size: 5,000+ employees, industry unknown']) {
    const s = applyIcpGate(parseScores(line(note), 1)!, icp)[0]
    assert.equal(s.match.size, 'mismatch', note); assert.ok(s.fit <= 1, note)
  }
})
test('Qodo #1519: coordinated criterion names share the trailing unknown cue; a stated value in the list still holds', () => {
  for (const note of ['headcount and revenue not stated', 'headcount, revenue not stated', 'headcount, revenue, and employee count unknown', 'revenue or headcount unknown', 'employee count and funding unknown']) {
    const s = applyIcpGate(parseScores(line(note), 1)!, icp)[0]
    assert.equal(s.match.size, 'unknown', note); assert.equal(s.fit, 5, note)
  }
  for (const note of ['headcount 5000, wanted 5-200', 'headcount, revenue not stated; 12000 staff', 'team, 5,000+ employees']) {
    const s = applyIcpGate(parseScores(line(note), 1)!, icp)[0]
    assert.equal(s.match.size, 'mismatch', note); assert.ok(s.fit <= 1, note)
  }
})
