import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { atsRecord, atsPostingRef } from '../lib/sources/ats-posting.ts'
import { reportsToBuyer, OWN_POSTING_PERSON_LABEL } from '../lib/connectors/sitecrawl.ts'
import { siteContactFromRows } from '../lib/scan/site-contact.ts'

// Run 679a7354 (HowGood, founding SDR, Lever a9cf54b8, 10-20): held no_named_buyer_with_contact_route. HowGood's site names no
// founder, but its own posting (saved live 2026-11-21) says "Reports to: Rachel Calomeni, SVP of Sales". /contact publishes contact@howgood.com.
const URL_ = 'https://jobs.lever.co/HowGood/a9cf54b8-b57f-4293-ac40-009ebb3aadd9'
const rec = atsRecord(JSON.parse(readFileSync(new URL('./fixtures/howgood/lever-a9cf54b8.json', import.meta.url), 'utf8')), atsPostingRef(URL_)!)
const text = rec && rec !== 'missing' ? `${rec.header} ${rec.description}` : ''

test('HowGood: the named sales leader in its own posting\'s "Reports to" line is a buyer', () => {
  assert.deepEqual(reportsToBuyer(text, 'Founder, CEO, Head of Sales'), { name: 'Rachel Calomeni', title: 'SVP of Sales' })
})
test('Reports-to reader holds: no name, a non-buyer title, or a title-shaped name is nothing', () => {
  assert.equal(reportsToBuyer('Reports to: our CEO', 'Founder, CEO, Head of Sales'), null)
  assert.equal(reportsToBuyer('Reports to: Jane Smith, Customer Success Lead', 'Founder, CEO, Head of Sales'), null)
  assert.equal(reportsToBuyer('Reports to: Sales Director, VP of Sales', 'Founder, CEO, Head of Sales'), null)
  assert.equal(reportsToBuyer('We partner directly with our CEO', 'Founder, CEO, Head of Sales'), null)
})
test('contact rule: a person from the lead\'s own posting counts beside a published own-domain route; a posting person on any other host does not', () => {
  const route = { connector: 'sitecrawl', kind: 'email', value: 'contact@howgood.com', source_url: 'https://howgood.com/contact', label: 'x' }
  const person = { connector: 'sitecrawl', kind: 'person', value: 'Rachel Calomeni, SVP of Sales', source_url: URL_, label: OWN_POSTING_PERSON_LABEL }
  const c = siteContactFromRows('howgood.com', true, 'Founder, CEO, Head of Sales', [route, person])
  assert.equal(c.person?.value, 'Rachel Calomeni, SVP of Sales'); assert.equal(c.route?.value, 'contact@howgood.com')
  assert.equal(siteContactFromRows('howgood.com', true, 'Founder, CEO, Head of Sales', [route, { ...person, source_url: 'https://example.com/team' }]).person, null)
  assert.equal(siteContactFromRows('howgood.com', true, 'Founder, CEO, Head of Sales', [route, { ...person, label: 'listed' }]).person, null)
  assert.equal(siteContactFromRows('howgood.com', false, 'Founder, CEO, Head of Sales', [route, person]).person, null)
})
