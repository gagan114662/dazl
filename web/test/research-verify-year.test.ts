// Research verify: the year in a date quote (part D). Kept apart from research-verify.test.ts so this change and the goal-loop change
// (#1272) never touch the same file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dateQuoteNames } from '../lib/research/verify.ts'

test('a date quote that states a different YEAR never dates the day ("2 October 2025" is not 2026-10-02); a street number is not a year (real Vancouver lead: "1944 W 4th Ave. on Sept. 20")', () => {
  const at = Date.parse('2026-11-14T12:00:00Z')
  const names = (iso: string, q: string) => dateQuoteNames(iso, q, at)
  // a year-old event read as this year's: refused, in every format and language the engine reads
  for (const q of ['2 October 2025', 'October 2, 2025', '2nd of October 2025', 'Oct. 2nd, 2025', '02/10/2025', '2.10.2025', '2025-10-02', '2. Oktober 2025', '2 octobre 2025', 'Oct 2025']) assert.equal(names('2026-10-02', q), false, q)
  // the same day of this year is still named
  for (const q of ['2 October 2026', 'October 2, 2026', '2nd of October 2026', '02/10/2026', '2.10.2026', '2026-10-02', '2. Oktober 2026', '2 octobre 2026', 'Oct 2, 2026', 'October 2026']) assert.equal(names('2026-10-02', q), true, q)
  // no year stated: the month and day alone, as before
  assert.equal(names('2026-10-02', 'Thursday 2 October'), true)
  assert.equal(names('2026-10-02', 'will open on October 2.'), true)
  // a number that is not a year in date position: a street number (the real quote), a count, a founding year in other words
  assert.equal(names('2026-09-20', 'Fable Kitchen will close at 1944 W 4th Ave. on Sept. 20.'), true, 'the real Vancouver lead stays ready')
  assert.equal(names('2026-10-02', 'The office at 2025 Main St opens on October 2.'), true)
  assert.equal(names('2026-10-02', 'Since 1998 the firm opens a second office on October 2.'), true)
  // another year beside this one is fine; a conflicting year in date position beside a bare day is refused
  assert.equal(names('2026-10-02', 'Founded March 3, 1998; reopening October 2, 2026'), true)
  assert.equal(names('2026-10-02', 'Founded in October 1998, reopening 2 October'), false, 'fails closed: a stated year that is not this one')
  // the day must still match
  assert.equal(names('2026-10-02', 'October 3, 2026'), false)
  // words that merely START like a month are not months ("Market 2025" is not "Mar 2025", "Junior" not "Jun", "Mayor" not "May")
  for (const q of ['Farmers Market 2025 season reopens October 2', 'Junior 2025 league starts October 2', 'Mayor 2025 budget; opens October 2', 'Decor 2025 showroom opens 2 October 2026']) assert.equal(names('2026-10-02', q), true, q)
  // the year may come BEFORE the month: still refused when it is not this year
  for (const q of ['2025, 2 October', 'in 2025 on 2 October', '2025 October 2', '2025 the 2nd of October']) assert.equal(names('2026-10-02', q), false, q)
  for (const q of ['2026, 2 October', 'in 2026 on 2 October', '2026 October 2']) assert.equal(names('2026-10-02', q), true, q)
  // documented gaps, pinned so a change is deliberate: a number right after the day reads as its year (fails closed); 2-digit years are not read
  assert.equal(names('2026-09-20', 'Sept. 20 1944 W 4th Ave.'), false, 'fails closed: a street number straight after the day')
  assert.equal(names('2026-10-02', '2 Oct 25'), true, 'a 2-digit year is not read (unchanged)')
  // the cases only the year rule can change (a named month beside a numeric date, a day range or list, words that start like a month)
  for (const q of ['02/10/2025 opens October 2', '2025-10-02, October 2', '2.10.2025 - opens October 2', 'October 2-4, 2025', 'October 2 and 3, 2025', 'Oct 2 to 4 2025', '2-4 October 2025', '2\u00a0Oct\u00a02025']) assert.equal(names('2026-10-02', q), false, q)
  for (const q of ['02/10/2026 opens October 2', '2026-10-02, October 2', 'October 2-4, 2026', 'October 2 and 3, 2026', 'Decision 2025 plan: we open on October 2', 'Junction 2025 opens October 2', 'Maison 2019 opens October 2', 'The Marathon 2025 winner opens a store October 2']) assert.equal(names('2026-10-02', q), true, q)
  // known trade-offs (fail closed), pinned: a founding month and year beside a bare event day; an address number that follows the month and day
  assert.equal(names('2026-10-02', 'In business since March 2019, our second location opens October 2.'), false)
  assert.equal(names('2026-10-02', 'Oct 2, 2025 - Oct 2, 2026'), true, 'a range that ends this year names it')
})
