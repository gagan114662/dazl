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
  // any other year in date position fails closed, even beside this one: the date quote is the date text
  assert.equal(names('2026-10-02', 'Founded March 3, 1998; reopening October 2, 2026'), false)
  for (const q of ['2 October 2025 (updated 2 October 2026)', '2 October 2025 - 2 October 2026', 'Published 2 October 2025, updated 02/10/2026']) assert.equal(names('2026-10-02', q), false, q)
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
  assert.equal(names('2026-10-02', '2 Oct 25'), true, 'a bare 2-digit year is not read (cannot be told from a count)')
  for (const q of ["Oct 2nd '25", "2 October '25", 'Oct 2, \u201925']) assert.equal(names('2026-10-02', q), false, q)
  for (const q of ["Oct 2nd '26", "2 October '26"]) assert.equal(names('2026-10-02', q), true, q)
  // the cases only the year rule can change (a named month beside a numeric date, a day range or list, words that start like a month)
  for (const q of ['02/10/2025 opens October 2', '2025-10-02, October 2', '2.10.2025 - opens October 2', 'October 2-4, 2025', 'October 2 and 3, 2025', 'Oct 2 to 4 2025', '2-4 October 2025', '2\u00a0Oct\u00a02025']) assert.equal(names('2026-10-02', q), false, q)
  for (const q of ['02/10/2026 opens October 2', '2026-10-02, October 2', 'October 2-4, 2026', 'October 2 and 3, 2026', 'Decision 2025 plan: we open on October 2', 'Junction 2025 opens October 2', 'Maison 2019 opens October 2', 'The Marathon 2025 winner opens a store October 2']) assert.equal(names('2026-10-02', q), true, q)
  // known trade-offs (fail closed), pinned: a founding month and year beside a bare event day; an address number that follows the month and day
  assert.equal(names('2026-10-02', 'In business since March 2019, our second location opens October 2.'), false)
  assert.equal(names('2026-10-02', 'Oct 2, 2025 - Oct 2, 2026'), false, 'a range that starts in another year: fails closed')
  // a year that ENDS a sentence or clause before a bare month and day is not the date's year (review: these were refused by the year-before-month rule)
  for (const q of ['Revenue grew in 2025. On October 2 we open a new office.', 'Prices in 2025 may rise; the store opens October 2.', 'Best of 2025: October 2 launch of our new line', 'Since 2019, on October 2 we open', 'The 2025 Mar-a-Lago event; opens October 2', 'Revenue grew in 2025.\nOctober 2 we open']) assert.equal(names('2026-10-02', q), true, q)
  assert.equal(names('2026-05-02', 'After a strong 2025, May 2 marks our relaunch.'), true, 'comma then month-first is prose, not a date')
  // a year that STARTS the next sentence or clause after the date is not the date's year (the after-month rule ran on the flattened quote)
  for (const q of ['We open on October 2. 2025 was our best year.', 'We open October 2; 2025 sales rose 10%', 'Opening October 2 | 2025 Awards Winner', 'October 2 / 2025 recap', 'opens Oct 2 \u2013 2025 Annual Report', 'Opens Oct. 2nd. 2025 revenue topped $1M', 'October 2 - 2030 goals announced']) assert.equal(names('2026-10-02', q), true, q)
  // more English wrong-year forms
  for (const q of ['October 2 of 2025', 'October 2nd of 2025', 'October 2nd, of 2025', 'October the 2nd, 2025', 'October 2 in 2025', 'October 2 (2025)', '2 October (2025)', '2  October  2025', '2\tOctober\t2025']) assert.equal(names('2026-10-02', q), false, q)
  // German and French dates with the year first or an accented month (the raw quote is accent-folded like flat())
  assert.equal(names('2026-03-02', '2025, 2. M\u00e4rz'), false); assert.equal(names('2026-08-02', '2025, 2 ao\u00fbt'), false); assert.equal(names('2026-03-02', '2. M\u00e4rz 2026'), true)
  assert.equal(names('2026-10-01', '1er octobre 2025'), false); assert.equal(names('2026-10-01', '1er octobre 2026'), true)
  // apostrophe years in either quote mark
  for (const q of ["Oct 2nd \u201825", "2 October \u201925", "Oct 2nd '25"]) assert.equal(names('2026-10-02', q), false, q)
  for (const q of ["Oct 2nd \u201826", "2 October '26"]) assert.equal(names('2026-10-02', q), true, q)
  // only spaces join a year to a date: ":", ")", "." and a newline do not (pinned)
  for (const q of ['2025: October 2', '(2025) October 2', 'in 2025.\nOctober 2']) assert.equal(names('2026-10-02', q), true, q)
  // a bare two-digit year is NOT read, because it would refuse real times and counts: "October 2, 10:30 am", "2 October 10 guests"
  for (const q of ['October 2, 10:30 am', 'October 2 at 10 am', '2 October 10 guests', 'October 2, 11:00']) assert.equal(names('2026-10-02', q), true, q)
  // trade-offs of the strict rule, pinned (fail closed): a second date in another year inside the date quote, a year joined to a bare month and day
  assert.equal(names('2026-01-05', 'Posted December 30, 2025: the store opens January 5'), false, 'year boundary: the quote states a date in 2025 (fails closed; the date quote should hold only the event\'s date)')
  assert.equal(names('2026-01-05', 'The store opens January 5'), true)
  assert.equal(names('2026-01-05', 'Posted December 30, 2025, the store opens January 5, 2026'), false, 'the date quote carries another year')
  assert.equal(names('2026-10-02', 'Since 2019 October 2 is our day'), false, 'a year directly before a month and day joins the date: fails closed')
})
