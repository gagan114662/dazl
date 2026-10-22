import test from 'node:test'
import assert from 'node:assert/strict'
import { rankPeople, contactsFromEnrichments } from '../lib/people/rank.ts'

const ICP = 'B2B companies actively hiring for sales operations manager or CRM administrator roles'

test('ranks contacts by title overlap with the ICP, best first', () => {
  const ranked = rankPeople([
    { name: 'Ada Lovelace', title: 'Head of Sales Operations', linkedin: 'https://li/ada', connector: 'Apollo' },
    { name: 'Alan Turing', title: 'Staff Software Engineer', linkedin: 'https://li/alan', connector: 'Apollo' },
    { name: 'Grace Hopper', title: 'CRM Administrator', linkedin: null, connector: 'People Data Labs' },
  ], ICP)
  assert.equal(ranked[0].name, 'Ada Lovelace') // sales + operations = 2
  assert.equal(ranked[1].name, 'Grace Hopper') // crm + administrator = 2, later input order loses the tie
  assert.equal(ranked[2].name, 'Alan Turing') // 0 matches, still present, never hidden
  assert.deepEqual(ranked[0].matched.sort(), ['operations', 'sales'])
  assert.equal(ranked[2].score, 0)
})

test('no title or empty ICP: contact kept, score 0, order preserved', () => {
  const ranked = rankPeople([
    { name: 'No Title', title: null, linkedin: null, connector: 'Apollo' },
    { name: 'Some Title', title: 'Sales Manager', linkedin: null, connector: 'Apollo' },
  ], '')
  assert.deepEqual(ranked.map(r => r.name), ['No Title', 'Some Title'])
  assert.ok(ranked.every(r => r.score === 0))
})

test('stopwords and generic words never count as matches', () => {
  const ranked = rankPeople([
    { name: 'A', title: 'Manager of Team Roles', linkedin: null, connector: 'Apollo' },
  ], 'companies hiring for manager roles')
  // "manager" is content, "roles"/"team"/"companies"/"hiring" are stopwords
  assert.deepEqual(ranked[0].matched, ['manager'])
})

test('contactsFromEnrichments splits name and title on the first dash only', () => {
  const ranked = contactsFromEnrichments([
    { kind: 'contact', value: 'Dana Scully - VP Sales - West Coast', label: 'Apollo', source_url: 'https://li/dana' },
    { kind: 'contact', value: 'Fox Mulder', label: 'Apollo', source_url: '' },
    { kind: 'firmographic', value: '500 employees', label: 'Apollo', source_url: 'https://x' },
  ], 'VP sales')
  assert.equal(ranked.length, 2) // firmographic rows are not contacts
  assert.equal(ranked[0].name, 'Dana Scully')
  assert.equal(ranked[0].title, 'VP Sales - West Coast')
  assert.deepEqual(ranked[0].matched.sort(), ['sales', 'vp'])
  assert.equal(ranked[1].name, 'Fox Mulder')
  assert.equal(ranked[1].title, null)
  assert.equal(ranked[1].linkedin, null)
})

test('single generic word is a weak match, two or more words is strong, zero is none', () => {
  const ranked = rankPeople([
    { name: 'Weak', title: 'VP Sales', linkedin: null, connector: 'Apollo' }, // only "sales"
    { name: 'Strong', title: 'Head of Sales Operations', linkedin: null, connector: 'Apollo' }, // sales + operations
    { name: 'None', title: 'Staff Software Engineer', linkedin: null, connector: 'Apollo' },
  ], 'sales operations manager')
  assert.equal(ranked[0].name, 'Strong')
  assert.equal(ranked[0].tier, 'strong')
  assert.equal(ranked[1].name, 'Weak')
  assert.equal(ranked[1].tier, 'weak')
  assert.equal(ranked[2].tier, 'none')
})

test('a title matching only the generic word manager is weak, never strong', () => {
  const ranked = rankPeople([
    { name: 'Mgr', title: 'Engineering Manager', linkedin: null, connector: 'Apollo' },
  ], 'sales operations manager')
  assert.equal(ranked[0].tier, 'weak')
  assert.deepEqual(ranked[0].matched, ['manager'])
})
