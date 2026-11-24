// Staging, 2026-11-24: of 16 leads the people pass looked up, every lookup saw LinkedIn profile results, 4 ended with no profile and 2
// with one the keep rule refused. dazl now reads the results itself when the lookup ends without a profile. The rule has to be hard to
// fool: attaching someone else's profile is worse than attaching none (the cases below come from the independent review of PR #1692).
import test from 'node:test'
import assert from 'node:assert/strict'
import { companyWords, keepSeenProfile, pickSeenProfile } from '../lib/discover/enrich.ts'
import type { SeenPage } from '../lib/discover/agent.ts'

const seen = (rows: [url: string, title: string | null][]): Map<string, SeenPage> => new Map(rows.map(([url, title]) => [url, { url, title, page_age: null, text: null }]))
const one = (title: string) => seen([['https://www.linkedin.com/in/someone-1', title]])
const PROFILE = 'https://www.linkedin.com/in/someone-1'

test('the one profile result that starts with the person\'s name and states the company is theirs', () => {
  const s = seen([
    ['https://www.linkedin.com/in/dana-ruiz-4b1a2', 'Dana Ruiz - Practice Owner - Northwind Dental | LinkedIn'],
    ['https://www.linkedin.com/in/dana-ruiz-99', 'Dana Ruiz - Account Manager - Harbour Freight | LinkedIn'],
    ['https://www.linkedin.com/company/northwind-dental', 'Northwind Dental | LinkedIn'],
    ['https://northwind-dental.example/team', 'Our team - Northwind Dental'],
  ])
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental', s), 'https://www.linkedin.com/in/dana-ruiz-4b1a2')
  assert.equal(pickSeenProfile('Dr. Dana M. Ruiz', 'Northwind Dental Inc.', s), 'https://www.linkedin.com/in/dana-ruiz-4b1a2', 'a title, a middle initial and a legal suffix do not matter')
  for (const title of ['Lena Hart - Founder & CEO at Indigo Labs | LinkedIn', 'Lena Hart – Indigo Labs', 'Lena Hart - CEO, Indigo Labs Inc. | LinkedIn', 'Lena Hart | Founder @ Indigo Labs (YC X20) | LinkedIn'])
    assert.equal(pickSeenProfile('Lena Hart', 'Indigo Labs', one(title)), PROFILE, title)
  assert.equal(pickSeenProfile('Emil Karan', 'Sim', one('Emil Karan - Co-Founder & CEO - Sim | LinkedIn')), PROFILE, 'a one-word company, stated as the company')
  assert.equal(pickSeenProfile('Emil Karan', 'Sim', one('Emil Karan - CEO at Sim | LinkedIn')), PROFILE)
  assert.equal(pickSeenProfile('Emil Karan', 'Sim', one('Emil Karan – Founder @Sim')), PROFILE)
  assert.equal(pickSeenProfile('Bo Lin', 'Brightsprint (YC P26)', one('Bo Lin - Co-Founder & CEO at Brightsprint | LinkedIn')), PROFILE, 'bracketed text is not part of the company name')
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental Group LLC', one('Dana Ruiz - Owner - Northwind Dental Group | LinkedIn')), PROFILE, 'the whole name as written, with or without its legal form')
  assert.equal(pickSeenProfile('Dana Ruiz', 'The Northwind Dental Company', one('Dana Ruiz - Owner at Northwind Dental | LinkedIn')), PROFILE)
})

test('never someone else: a same-named person elsewhere, a headline that mentions the person, a former job, a longer company name', () => {
  const none = (person: string, company: string, title: string, why: string) => assert.equal(pickSeenProfile(person, company, one(title)), null, why)
  none('John Smith', 'Smith Roofing', 'John Smith - Roofing Contractor - ABC Exteriors | LinkedIn', 'the company words must not come from his own name and job')
  none('Dana Ruiz', 'Northwind Dental', 'Dana Ruiz - Dental Assistant - Northwind Logistics | LinkedIn', 'the company\'s words must stand together, in order')
  none('Dana Ruiz', 'Northwind Dental', 'Maria Lopez - Executive Assistant to Dana Ruiz at Northwind Dental | LinkedIn', 'a profile that mentions the person is someone else\'s')
  none('Dana Ruiz', 'Northwind Dental', 'Dana Ruiz - ex Northwind Dental | LinkedIn', 'a former job')
  none('Dana Ruiz', 'Northwind Dental', 'Dana Ruiz - Former Owner at Northwind Dental, now at Harbour | LinkedIn', 'a former job')
  none('Jane Doe', 'Quanta', 'Jane Doe - Engineer at Quanta Services | LinkedIn', 'another company whose name starts the same')
  none('Dana Ruiz', 'Northwind Dental Group', 'Dana Ruiz - Owner - Northwind Dental Supply | LinkedIn', 'every word of the name, not only the first two')
  none('Sam Lee', 'Sim', 'Sam Lee - Sim Racing Coach | LinkedIn', 'a word that is not the company')
  none('Sam Lee', 'Sim', 'Sam Lee - Founder at Racing Sim | LinkedIn', 'a one-word name inside another company\'s name')
  none('Dana Ruiz', 'Ramp', 'Dana Ruiz - Helping startups ramp | LinkedIn', 'a one-word name used as an ordinary word')
  none('Dana Ruiz', 'Northwind Dental', 'Dana Ruiz - Northwind Dental (former) | LinkedIn', 'a former job, said after the name')
  none('Dana Ruiz', 'Northwind Dental', 'Dana Ruiz - Account Manager - Harbour Freight | LinkedIn', 'the name alone')
  none('Dana Ruiz', 'Northwind Dental', 'D. Ruiz - Owner - Northwind Dental | LinkedIn', 'an initial is not the first name')
  none('Dana', 'Northwind Dental', 'Dana - Northwind Dental | LinkedIn', 'a first name alone names nobody')
  none('Dana Ruiz', 'Northwind Dental', 'Dana Ruiz', 'a title with no headline says nothing about the company')
  assert.equal(pickSeenProfile(null, 'Northwind Dental', one('Dana Ruiz - Owner - Northwind Dental | LinkedIn')), null)
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental', seen([['https://www.linkedin.com/company/northwind-dental', 'Dana Ruiz - Owner - Northwind Dental | LinkedIn'], ['https://www.linkedin.com/posts/dana-ruiz_x', 'Dana Ruiz - Owner - Northwind Dental | LinkedIn']])), null, 'a company page or a post is not a profile')
})

test('two different profiles are left for a person to settle; the same profile on two hosts is one', () => {
  const two = seen([['https://www.linkedin.com/in/dana-ruiz-1', 'Dana Ruiz - Owner - Northwind Dental | LinkedIn'], ['https://ca.linkedin.com/in/dana-ruiz-2', 'Dana Ruiz - Hygienist - Northwind Dental | LinkedIn']])
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental', two), null)
  const same = seen([['https://www.linkedin.com/in/dana-ruiz-1', 'Dana Ruiz - Owner - Northwind Dental | LinkedIn'], ['https://ca.linkedin.com/in/dana-ruiz-1/', 'Dana Ruiz - Northwind Dental']])
  assert.ok(pickSeenProfile('Dana Ruiz', 'Northwind Dental', same))
})

test('the company\'s own words: filler and bracketed text are not part of the name; a name with no word of its own never matches', () => {
  assert.deepEqual(companyWords('The Group Inc.'), [])
  assert.deepEqual(companyWords('Northwind Dental Group LLC'), ['northwind', 'dental'])
  assert.deepEqual(companyWords('Café Olmühle GmbH'), ['cafe', 'olmuhle'])
  assert.deepEqual(companyWords('Brightsprint (YC P26)'), ['brightsprint'])
  assert.deepEqual([companyWords('Sim'), companyWords('Indigo Labs'), companyWords('StackedXY')], [['sim'], ['indigo', 'labs'], ['stackedxy']])
  assert.equal(pickSeenProfile('Dana Ruiz', 'The Group Inc.', one('Dana Ruiz - Owner - The Group Inc | LinkedIn')), null)
})

// Staging, 2026-11-24: of 5 lookups that ended with no profile, one was a real loss. The model chose the right profile for "Rob Hale";
// its result title read "Robert Hale - Leeds, England, United Kingdom", and the keep rule wanted the first name letter for letter.
test('a profile the model chose is kept when the result\'s title gives the long or short form of the first name', () => {
  const e = (person: string, url: string) => ({ domain: null, person, title: null, person_source_url: 'https://x.example/team', linkedin_url: url, email: null, email_source_url: null })
  const url = 'https://www.linkedin.com/in/robert-hale-1a2b3/'
  const s = seen([[url, 'Robert Hale - Leeds, England, United Kingdom'], ['https://www.linkedin.com/in/ben-wright-4c5d6/', 'Ben Wright - Northlayer']])
  assert.equal(keepSeenProfile(e('Rob Hale', url), s).linkedin_url, url, 'Rob and Robert are one first name')
  assert.equal(keepSeenProfile(e('Robert Hale', url), seen([[url, 'Rob Hale - Northlayer']])).linkedin_url, url, 'and the other way round')
  assert.equal(keepSeenProfile(e('Rob Hale', url), seen([[url, 'Ro Hale - Northlayer']])).linkedin_url, null, 'two letters are not a name')
  assert.equal(keepSeenProfile(e('Rob Hale', url), seen([[url, 'Robert Gale - Northlayer']])).linkedin_url, null, 'the last name is exact')
  assert.equal(keepSeenProfile(e('Rob Hale', url), seen([[url, 'Ben Hale - Northlayer']])).linkedin_url, null, 'a different first name')
  assert.equal(keepSeenProfile(e('Rob Hale', 'https://www.linkedin.com/in/someone-else/'), s).linkedin_url, null, 'a profile the lookup never saw is still refused')
})
