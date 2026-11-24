// Staging, 2026-11-24: of 16 leads the people pass looked up, every lookup saw LinkedIn profile results, 4 ended with no profile and 2
// with one the keep rule refused. dazl now reads the results itself when the lookup ends without a profile: the one result whose
// title carries the person's first and last name and the company's own name.
import test from 'node:test'
import assert from 'node:assert/strict'
import { companyWords, pickSeenProfile } from '../lib/discover/enrich.ts'
import type { SeenPage } from '../lib/discover/agent.ts'

const seen = (rows: [url: string, title: string | null][]): Map<string, SeenPage> => new Map(rows.map(([url, title]) => [url, { url, title, page_age: null, text: null }]))

test('the one profile result naming the person and the company is theirs', () => {
  const s = seen([
    ['https://www.linkedin.com/in/dana-ruiz-4b1a2', 'Dana Ruiz - Practice Owner - Northwind Dental | LinkedIn'],
    ['https://www.linkedin.com/in/dana-ruiz-99', 'Dana Ruiz - Account Manager - Harbour Freight | LinkedIn'],
    ['https://www.linkedin.com/company/northwind-dental', 'Northwind Dental | LinkedIn'],
    ['https://northwind-dental.example/team', 'Our team - Northwind Dental'],
  ])
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental', s), 'https://www.linkedin.com/in/dana-ruiz-4b1a2')
  assert.equal(pickSeenProfile('Dr. Dana M. Ruiz', 'Northwind Dental Inc.', s), 'https://www.linkedin.com/in/dana-ruiz-4b1a2', 'a title, a middle initial and a legal suffix do not matter')
  assert.equal(pickSeenProfile('Dana Ruiz', 'NORTHWIND dental', s), 'https://www.linkedin.com/in/dana-ruiz-4b1a2')
})

test('never a same-named person at another company, a company page, or a guess between two profiles', () => {
  const other = seen([['https://www.linkedin.com/in/dana-ruiz-99', 'Dana Ruiz - Account Manager - Harbour Freight | LinkedIn'], ['https://www.linkedin.com/company/northwind-dental', 'Dana Ruiz joins Northwind Dental | LinkedIn']])
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental', other), null, 'the name alone, or a company page naming both, is not a profile of this person')
  const two = seen([['https://www.linkedin.com/in/dana-ruiz-1', 'Dana Ruiz - Owner - Northwind Dental | LinkedIn'], ['https://ca.linkedin.com/in/dana-ruiz-2', 'Dana Ruiz - Hygienist - Northwind Dental | LinkedIn']])
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental', two), null, 'two different profiles for one name at one company: left for a person to settle')
  const same = seen([['https://www.linkedin.com/in/dana-ruiz-1', 'Dana Ruiz - Owner - Northwind Dental | LinkedIn'], ['https://ca.linkedin.com/in/dana-ruiz-1/', 'Dana Ruiz - Northwind Dental']])
  assert.ok(pickSeenProfile('Dana Ruiz', 'Northwind Dental', same), 'the same profile on two LinkedIn hosts is one profile')
  assert.equal(pickSeenProfile('Dana', 'Northwind Dental', seen([['https://www.linkedin.com/in/dana-1', 'Dana - Northwind Dental | LinkedIn']])), null, 'a first name alone names nobody')
  assert.equal(pickSeenProfile(null, 'Northwind Dental', two), null)
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental', seen([['https://www.linkedin.com/in/d-ruiz', 'D. Ruiz - Owner - Northwind Dental | LinkedIn']])), null, 'an initial is not the first name')
  assert.equal(pickSeenProfile('Dana Ruiz', 'Northwind Dental', seen([['https://www.linkedin.com/in/dana-ruiz-1', 'Dana Ruiz - Owner - Northwind Smiles | LinkedIn']])), null, 'both of the company\'s own words must be in the title')
})

test('a company name with no word of its own is never matched', () => {
  assert.deepEqual(companyWords('The Group Inc.'), [])
  assert.deepEqual(companyWords('Northwind Dental Group LLC'), ['northwind', 'dental'])
  assert.deepEqual(companyWords('Café Olmühle GmbH'), ['cafe', 'olmuhle'])
  assert.equal(pickSeenProfile('Dana Ruiz', 'The Group Inc.', seen([['https://www.linkedin.com/in/dana-ruiz-1', 'Dana Ruiz - Owner - The Group Inc | LinkedIn']])), null)
})
