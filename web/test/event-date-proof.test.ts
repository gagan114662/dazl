import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyEvidence, type Candidate } from '../lib/scan/evidence.ts'

const quote = 'Acme Logistics opened a second depot and is hiring twelve drivers'
const candidate: Candidate = { name: '', company: 'Acme Logistics', contact: null, signal: 'Expansion', source_url: 'https://acme.example/news', score: 70, excerpt: quote, event_date: '2026-10-01' }
const now = new Date('2026-10-20T12:00:00Z')
const page = (context: string) => ({ text: `${context}. ${quote}.`, title: 'Acme Logistics', retrievedAt: 1800000000 })

for (const context of [
  '© 2026 Acme Logistics', 'Copyright 2026', '2026 Industrial Road',
  'Founded in 2019', 'Published March 2019', 'Published October 2026',
  'Published October 1, 2026', 'Updated 2026-10-01',
  'The other depot opened October 1, 2026',
  'May offer services. 2026 customers served', 'March toward 2026 goals',
  'Augustine joined in 2026', '2026-00-01', '2026-13-01', '2026-02-30',
  'October 32, 2026', '2026', '2019 and 2026', '',
]) {
  test(`nearby text does not prove or contradict event day: ${context || '(none)'}`, () => {
    const v = verifyEvidence(candidate, page(context), now)
    assert.equal(v.ok, true)
    if (v.ok) { assert.equal(v.dateStatus, 'unverified'); assert.equal(v.confidence, 55) }
    assert.equal(candidate.event_date, '2026-10-01')
  })
}
for (const date of ['2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32', '2026-02-29', '2026-02-30', '2026-04-31', '2026-1-01', '2026-01-1']) {
  test(`candidate day must be a real YYYY-MM-DD date: ${date}`, () => {
    assert.deepEqual(verifyEvidence({ ...candidate, event_date: date }, page(date), now), { ok: false, reason: 'bad_date' })
  })
}
test('valid leap day remains an unverified claim, null remains undated', () => {
  const v = verifyEvidence({ ...candidate, event_date: '2028-02-29' }, page('February 29, 2028'), new Date('2028-03-01T12:00:00Z'))
  assert.equal(v.ok && v.dateStatus, 'unverified')
  const undated = verifyEvidence({ ...candidate, event_date: null }, page('October 1, 2026'), now)
  assert.equal(undated.ok && undated.dateStatus, 'undated')
})
