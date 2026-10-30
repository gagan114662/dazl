import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calendarDay } from '../lib/day.ts'

// Run under TZ=America/Toronto too (see the PR): the result must not depend on the process time zone.
test('a date-only source date is the same calendar day in every time zone', () => {
  assert.equal(calendarDay('2026-10-21'), '21 Oct 2026')
  assert.equal(calendarDay('2026-01-01'), '1 Jan 2026', 'the first of the month does not become the 31st of the one before')
  assert.equal(calendarDay('2026-10-21T00:00:00Z'), '21 Oct 2026', 'the date part of a timestamp, as written')
  assert.equal(calendarDay(null), null)
  assert.equal(calendarDay('last week'), 'last week', 'anything else is shown as given, never guessed')
  assert.equal(calendarDay('2026-13-01'), '2026-13-01')
  // The bug this replaces: new Date('2026-10-21') is UTC midnight, the 20th in Toronto.
  if (process.env.TZ === 'America/Toronto') assert.equal(new Date('2026-10-21').getDate(), 20, 'the process really runs west of UTC')
})
