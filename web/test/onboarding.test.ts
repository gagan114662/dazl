import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWebsite, suggestPlays, vendorForKey } from '../lib/onboarding.ts'

const brain = { summary: 'Dental practices that need scheduling software', who: ['Practice owners', 'Office managers'], industries: ['dental'], where: ['Ohio'], signals: ['Opened a new location', 'hiring front-desk staff', 'switched practice software'] }

test('three distinct plays, each built from the reviewed profile', () => {
  const p = suggestPlays(brain)
  assert.equal(p.length, 3)
  assert.equal(new Set(p).size, 3)
  assert.deepEqual(p, ['Practice owners in Ohio - opened a new location', 'Office managers in Ohio - hiring front-desk staff', 'Practice owners in Ohio - switched practice software'])
  assert.ok(p.every(s => s.includes('in Ohio')))
})

test('a sparse profile still yields three editable plays without inventing a place', () => {
  const p = suggestPlays({ summary: 'Accounting firms', who: [], industries: [], where: [], signals: [] })
  assert.equal(p.length, 3)
  assert.equal(new Set(p).size, 3)
  assert.ok(p.every(s => s.startsWith('Accounting firms - ') && !s.includes(' in ')))
})

test('the key prefix picks the provider', () => {
  assert.equal(vendorForKey(' sk-ant-api03-abc '), 'anthropic')
  assert.equal(vendorForKey('sk-proj-abc'), 'openai')
  assert.equal(vendorForKey('hello'), null)
})

test('website input becomes an https URL', () => {
  assert.equal(normalizeWebsite('acme.com'), 'https://acme.com')
  assert.equal(normalizeWebsite('http://acme.com/about'), 'https://acme.com/about')
  assert.equal(normalizeWebsite('  '), '')
})
