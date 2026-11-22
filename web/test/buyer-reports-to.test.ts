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
test('contact rule: a person from the lead\'s own posting counts on the confirmed domain; a posting person on any other host does not', () => {
  const route = { connector: 'sitecrawl', kind: 'email', value: 'contact@howgood.com', source_url: 'https://howgood.com/contact', label: 'x' }
  const person = { connector: 'sitecrawl', kind: 'person', value: 'Rachel Calomeni, SVP of Sales', source_url: URL_, label: OWN_POSTING_PERSON_LABEL }
  const c = siteContactFromRows('howgood.com', true, 'Founder, CEO, Head of Sales', [route, person])
  assert.equal(c.person?.value, 'Rachel Calomeni, SVP of Sales'); assert.equal(c.route?.value, 'contact@howgood.com')
  assert.equal(siteContactFromRows('howgood.com', true, 'Founder, CEO, Head of Sales', [route, { ...person, source_url: 'https://example.com/team' }]).person, null)
  assert.equal(siteContactFromRows('howgood.com', true, 'Founder, CEO, Head of Sales', [route, { ...person, label: 'listed' }]).person, null)
  assert.equal(siteContactFromRows('howgood.com', false, 'Founder, CEO, Head of Sales', [route, person]).person, null)
})

test('PM #1513: contact@howgood.com is stored only as a company route - never the buyer email, never an email row, never the email bar', async () => {
  const { companyRouteRow } = await import('../lib/connectors/sitecrawl.ts')
  const row = companyRouteRow([{ kind: 'email', value: 'contact@howgood.com', url: 'https://howgood.com/contact' }], 'howgood.com', 1, '2026-11-21')!
  assert.equal(row.kind, 'company_route'); assert.equal(row.value, 'contact@howgood.com')
  const person = { connector: 'sitecrawl', kind: 'person', value: 'Rachel Calomeni, SVP of Sales', source_url: URL_, label: OWN_POSTING_PERSON_LABEL }
  const c = siteContactFromRows('howgood.com', true, 'Founder, CEO, Head of Sales', [person, { ...row, source_url: row.source_url ?? null }])
  assert.equal(c.person?.value, 'Rachel Calomeni, SVP of Sales')
  assert.equal(c.route, null, 'the role mailbox is not the buyer email and does not meet the email bar')
  assert.equal(companyRouteRow([{ kind: 'email', value: 'privacy@howgood.com', url: 'https://howgood.com/privacy' }], 'howgood.com', 1, 'd'), null)
  assert.equal(companyRouteRow([{ kind: 'email', value: 'contact@other.com', url: 'https://howgood.com/contact' }], 'howgood.com', 1, 'd'), null)
})

test('Qodo #1513: standalone executive titles parse, and a posting-named CRO reaches the contact rule for a Head of Sales request', () => {
  const who = 'Founder, CEO, Head of Sales'
  assert.deepEqual(reportsToBuyer('Reports to: Jane Smith, CEO', who), { name: 'Jane Smith', title: 'CEO' })
  assert.deepEqual(reportsToBuyer('Reports to: Jane Smith, Chief Revenue Officer. Benefits', who), { name: 'Jane Smith', title: 'Chief Revenue Officer' })
  assert.deepEqual(reportsToBuyer('Reports to: Jane Smith, CRO', who), { name: 'Jane Smith', title: 'CRO' })
  const cro = { connector: 'sitecrawl', kind: 'person', value: 'Jane Smith, Chief Revenue Officer', source_url: URL_, label: OWN_POSTING_PERSON_LABEL }
  assert.equal(siteContactFromRows('howgood.com', true, who, [cro]).person?.value, 'Jane Smith, Chief Revenue Officer')
  // the top-sales reading is the posting reader's only: a site-listed CRO keeps the existing rule, and a request without Head of Sales never takes it
  assert.equal(siteContactFromRows('howgood.com', true, 'Founder', [cro]).person, null)
})
