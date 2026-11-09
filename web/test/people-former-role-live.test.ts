// #781: the live person path (sitecrawl extractPeople -> contactCurrency) must not mark a person whose role has an
// explicit end date, or who is listed in an alumni/former-staff section, as verified current. Pure: fixed HTML, no fetch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPeople } from '../lib/connectors/sitecrawl.ts'
import { roleEndedByDate } from '../lib/people/rank.ts'
import { contactCurrency } from '../lib/people/currency.ts'

const prose = '<p>' + 'we help local teams grow with simple tools and honest advice for every customer today and always '.repeat(3) + '</p>'
const YEAR = new Date().getUTCFullYear()
const URL_ = 'https://harborledger.example/team'
const people = (body: string) => extractPeople(prose + body, URL_, 'sales director').map(f => f.value)

test('a role with an explicit end date is not listed as current staff', () => {
  assert.deepEqual(people('<p>Pat Example, Sales Director (until 2023)</p>'), [])
  assert.deepEqual(people('<p>Pat Example, Sales Director (2019 - 2023)</p>'), [])
  assert.deepEqual(people('<p>Pat Example, Sales Director (2019 to 2023)</p>'), [])
})

test('open, running, future-ended and interim roles stay current', () => {
  assert.deepEqual(people(`<p>Pat Example, Sales Director until ${YEAR + 2}</p>`), [`Pat Example, Sales Director until ${YEAR + 2}`])
  assert.deepEqual(people('<h3>Pat Example</h3><p>Interim Sales Director</p>'), ['Pat Example, Interim Sales Director'])
  assert.deepEqual(people('<p>Pat Example, Sales Director (2019 - present)</p>'), ['Pat Example, Sales Director (2019 - present)'])
  assert.deepEqual(people('<p>Pat Example, Sales Director since 2019</p>'), ['Pat Example, Sales Director since 2019'])
  assert.deepEqual(people(`<p>Pat Example, Sales Director (2019 - ${YEAR + 3})</p>`), [`Pat Example, Sales Director (2019 - ${YEAR + 3})`])
  assert.deepEqual(people('<h3>Pat Example</h3><p>Sales Director</p>'), ['Pat Example, Sales Director'])
})

test('a past-tense title in the row\'s own title text is dropped; a formerly clause keeps the existing fail-closed rule', () => {
  assert.deepEqual(people('<p>Pat Example, was Sales Director</p>'), [])
  assert.deepEqual(people('<h3>Pat Example</h3><p>Sales Director (formerly VP Sales)</p>'), [])
  // page prose containing "was" does not touch a listed current person
  assert.deepEqual(people('<p>The company was founded in 2010 by its owners.</p><h3>Pat Example</h3><p>Sales Director</p>'), ['Pat Example, Sales Director'])
})

test('as-of year decides an end date; bare "to <year>" is not an end date', () => {
  assert.equal(roleEndedByDate('Sales Director (2019 - 2023)', 2026), true)
  assert.equal(roleEndedByDate('Sales Director (2019 - 2026)', 2026), false)
  assert.equal(roleEndedByDate('Sales Director until Mar 2023', 2026), true)
  assert.equal(roleEndedByDate('Sales Director, relocating to 2023 plan', 2026), false)
  assert.equal(roleEndedByDate('Sales Director until 2027', 2026), false)
})

test('people under an alumni / former-staff heading are dropped; the scope ends at the next section', () => {
  assert.deepEqual(people('<h2>Alumni</h2><h3>Old Person</h3><p>Sales Director</p><h3>Other Person</h3><p>Sales Director</p>'), [])
  assert.deepEqual(people('<h2>Former team</h2><div><h3>Old Person</h3><p>Sales Director</p></div><h2>Leadership</h2><div><h3>Pat Example</h3><p>Sales Director</p></div>'), ['Pat Example, Sales Director'])
})

test('an advisory board is not a former section', () => {
  assert.deepEqual(people('<h2>Advisory board</h2><div><h3>Pat Example</h3><p>Sales Director</p></div>'), ['Pat Example, Sales Director'])
})

test('a dropped former person never reaches verified_current; a current one still does', () => {
  const now = Date.now()
  const row = { kind: 'person', connector: 'sitecrawl', label: null, retrieved_at: Math.floor(now / 1000), source_url: URL_ }
  const site = { state: 'established', site: 'harborledger.example', text: 'x' } as never
  const former = people('<h2>Alumni</h2><h3>Old Person</h3><p>Sales Director</p>')
  assert.equal(former.length, 0)
  assert.equal(contactCurrency(row, true, now, site).currency, 'verified_current')
})
