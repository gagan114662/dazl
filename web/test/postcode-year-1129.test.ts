// #1129 (from the #533 live check, comment 6841835996): an undated candidate whose quote carries an Australian address
// ("Sydney, NSW 2000 / Melbourne, VIC 3000") was held as event_date_stale with the note "the quote names 2000": the
// postcode was read as a year. A four-digit number right after a state or territory code is a postcode.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventYears } from '../lib/scan/date-in-text.ts'
import { resolveTiming } from '../lib/scan/page-timing.ts'

const LIVE = 'Sales Operations Manager Sydney, NSW 2000 / Melbourne, VIC 3000 Government – Sales / Hybrid Apply for this job'

test('#1129 a postcode after an Australian state or territory code is not a year', () => {
  assert.deepEqual(eventYears(LIVE), [])
  for (const q of ['Office at 1 Martin Place, Sydney NSW 2000', 'Parramatta, NSW, 2150 and Canberra ACT 2601', 'Perth WA 6000', 'Brisbane QLD 4000', 'Adelaide SA 5000', 'Darwin NT 0800', 'Hobart TAS 7000']) assert.deepEqual(eventYears(q), [], q)
  // a postcode that looks like a recent year is still a postcode
  assert.deepEqual(eventYears('Botany NSW 2019'), [])
})

test('#1129 real years are still read: in the same quote, in running text, and with lower-case words that are not state codes', () => {
  assert.deepEqual(eventYears(`${LIVE}. The team opened in 2019.`), [2019])
  assert.deepEqual(eventYears('We opened our Sydney office in 2018'), [2018])
  assert.deepEqual(eventYears('an act 2019 of parliament'), [2019], 'lower case is running text, not an address')
  assert.deepEqual(eventYears('founded in 2015, opened a clinic in 2017'), [2017], 'company background stays excluded')
})

test('#1129 the live quote no longer holds an undated lead as stale', () => {
  const t = resolveTiming(`${LIVE}. We are hiring a Sales Operations Manager.`, LIVE, null, 2026)
  assert.equal(t.olderYear, null)
  // and a quote that does name an old year still does
  assert.equal(resolveTiming('We opened in 2019 in Sydney NSW 2000.', 'We opened in 2019 in Sydney NSW 2000', null, 2026).olderYear, 2019)
})
