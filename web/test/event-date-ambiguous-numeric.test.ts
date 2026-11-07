// #780 (audit 9379b162, 2026-11-06 19:25Z): a numeric date whose day/month order the page does not settle is not
// event-day proof. "08/10/2026" is 8 October day-first and 10 August month-first; before this fix datesStatedIn
// returned BOTH days and eventDateBound bound EITHER claimed day, so a model-chosen reading could pass association
// proof even when the page meant the other month, including across a recency cutoff. Pure functions, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { datesStatedIn, dateStatedInText, dateMentions, datePositions } from '../lib/scan/date-in-text.ts'
import { eventDateBound } from '../lib/scan/event-date-binding.ts'

const CO = 'Aurora Agency'
const QUOTE = 'Aurora Agency opened a new office on 08/10/2026.'

test('the audited reproduction: 08/10/2026 states neither reading, and neither claimed day binds', () => {
  assert.deepEqual([...datesStatedIn(QUOTE)], [], 'an unsettled numeric order states no day')
  assert.equal(dateStatedInText('2026-10-08', QUOTE), false)
  assert.equal(dateStatedInText('2026-08-10', QUOTE), false)
  const [m] = dateMentions(QUOTE)
  assert.equal(m.ambiguous, true)
  assert.equal(m.day, null)
  assert.deepEqual(m.readings.sort(), ['2026-08-10', '2026-10-08'])
  for (const day of ['2026-10-08', '2026-08-10']) {
    const b = eventDateBound(day, QUOTE, QUOTE, CO)
    assert.equal(b.bound, false, `${day} must not bind`)
    assert.match(b.why, /day\/month order/, 'the hold names why')
    assert.match(b.why, /08\/10\/2026/)
  }
})

test('one reading inside the requested window, one outside: neither passes from the same source', () => {
  // As of 2026-10-20 with a 30-day window, 2026-10-08 is inside and 2026-08-10 is outside. A producer that picks
  // the in-window reading must not get proof the page never settled.
  const page = `News. ${QUOTE} The team is hiring.`
  const inside = eventDateBound('2026-10-08', page, QUOTE, CO)
  const outside = eventDateBound('2026-08-10', page, QUOTE, CO)
  assert.equal(inside.bound, false)
  assert.equal(outside.bound, false)
  assert.equal(inside.why.includes('2026-08-10'), true, 'names the other reading')
})

test('dot and slash separators are both ambiguous; the same number twice and a part over 12 are not', () => {
  for (const t of ['Aurora Agency opened an office on 8.10.2026.', 'Aurora Agency opened an office on 3/4/2026.']) {
    assert.equal(dateMentions(t)[0].ambiguous, true, t)
  }
  assert.deepEqual([...datesStatedIn('on 10/10/2026')], ['2026-10-10'], 'the same number twice reads one way')
  assert.deepEqual([...datesStatedIn('on 25/10/2026')], ['2026-10-25'], 'day over 12: day first')
  assert.deepEqual([...datesStatedIn('on 10/25/2026')], ['2026-10-25'], 'second part over 12: month first')
  assert.equal(eventDateBound('2026-10-25', 'Aurora Agency opened a new office on 25/10/2026.', 'Aurora Agency opened a new office on 25/10/2026.', CO).bound, true)
})

test('unambiguous ISO and month-name forms still bind', () => {
  for (const [day, q] of [
    ['2026-10-08', 'Aurora Agency opened a new office on 2026-10-08.'],
    ['2026-10-08', 'Aurora Agency opened a new office on October 8, 2026.'],
    ['2026-10-08', 'Aurora Agency opened a new office on 8 October 2026.'],
    ['2026-08-10', 'Aurora Agency opened a new office on Aug. 10, 2026.'],
  ] as const) assert.equal(eventDateBound(day, q, q, CO).bound, true, q)
})

test('real calendar validation stays: an impossible numeric date has no reading', () => {
  assert.deepEqual(dateMentions('on 31/02/2026'), [], 'neither 31 Feb nor month 31 exists')
  assert.deepEqual([...datesStatedIn('on 30/02/2026 and 2/30/2026')], [])
  assert.deepEqual([...datesStatedIn('on 29/02/2028')], ['2028-02-29'], 'a real leap day, one valid reading')
  assert.deepEqual(dateMentions('on 02/31/2026'), [], 'Feb 31 is invalid and 31 is not a month')
  assert.deepEqual([...datesStatedIn('on 12/31/2026')], ['2026-12-31'])
})

test('grounded format evidence on the same page settles the order; conflicting evidence keeps it ambiguous', () => {
  const dayFirst = 'Aurora Agency opened a new office on 08/10/2026. The lease was signed on 25/09/2026.'
  assert.equal(eventDateBound('2026-10-08', dayFirst, QUOTE, CO).bound, true, 'the page writes day first elsewhere (25/09)')
  assert.equal(eventDateBound('2026-08-10', dayFirst, QUOTE, CO).bound, false, 'and so it never means 10 August')
  const monthFirst = 'Aurora Agency opened a new office on 08/10/2026. The lease was signed on 07/25/2026.'
  assert.equal(eventDateBound('2026-08-10', monthFirst, QUOTE, CO).bound, true, 'the page writes month first elsewhere (07/25)')
  assert.equal(eventDateBound('2026-10-08', monthFirst, QUOTE, CO).bound, false)
  const both = 'Aurora Agency opened a new office on 08/10/2026. Signed 25/09/2026; renewed 07/25/2026.'
  for (const d of ['2026-10-08', '2026-08-10']) assert.equal(eventDateBound(d, both, QUOTE, CO).bound, false, `${d}: both orders evidenced, nothing settled`)
  // evidence is per separator: a day-first dotted date does not settle a slashed one
  const otherSep = 'Aurora Agency opened a new office on 08/10/2026. Signed 25.09.2026.'
  for (const d of ['2026-10-08', '2026-08-10']) assert.equal(eventDateBound(d, otherSep, QUOTE, CO).bound, false, `${d}: another separator is not evidence`)
})

test('ambiguous spans still protect sentence splitting (a dotted date is not a sentence end)', () => {
  const t = 'Aurora Agency opened a new office on 8.10.2026 in Toronto.'
  const pos = datePositions(t)
  assert.equal(pos.length, 2, 'one span per reading')
  assert.ok(pos.every(p => p.ambiguous && p.index === pos[0].index && p.end === pos[0].end))
})
