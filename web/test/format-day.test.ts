// A date-only value is a calendar day, not an instant: no timezone may move it. Run under several zones (TZ=America/Toronto, Pacific/Auckland, UTC) - the output must be identical.
import test from 'node:test'
import assert from 'node:assert/strict'
import { calendarDay } from '../lib/format-day.ts'

test('calendarDay keeps the calendar day in every timezone (Toronto showed 21 Oct as 20 Oct)', () => {
  assert.equal(calendarDay('2026-10-21'), '21 Oct 2026'); assert.equal(calendarDay('2026-01-01'), '1 Jan 2026'); assert.equal(calendarDay('2026-12-31'), '31 Dec 2026'); assert.equal(calendarDay('2026-03-08'), '8 Mar 2026')
  assert.equal(calendarDay('2026-10-21T00:00:00Z'), '21 Oct 2026', 'a UTC-midnight timestamp is still that calendar day'); assert.equal(calendarDay('2026-10-21 09:30'), '21 Oct 2026')
  assert.equal(calendarDay('2028-02-29'), '29 Feb 2028')
})
test('anything that is not a real calendar day is returned as stored, never guessed', () => {
  assert.equal(calendarDay(null), null); assert.equal(calendarDay(''), null)
  for (const x of ['soon', 'Q3 2026', '2026-02-30', '2026-13-01', '2026-00-10', '21/10/2026', '2026-10']) assert.equal(calendarDay(x), x, x)
})
test('the process timezone is irrelevant (this file is run under several TZ values by the PR command)', () => {
  assert.equal(calendarDay('2026-10-21'), '21 Oct 2026', `TZ=${process.env.TZ ?? 'unset'}`)
})
