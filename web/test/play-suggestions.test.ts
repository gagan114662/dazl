import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXAMPLE_PLAYS, playSuggestions } from '../lib/play-suggestions.ts'

test('an empty brain gets the three static examples, labelled as examples', () => {
  for (const p of [null, {}, { sells: '  ', buyer: null }, { buyer: { who: [], signals: ['x'] } }]) assert.deepEqual(playSuggestions(p), { from: 'examples', items: EXAMPLE_PLAYS })
})

test('a saved buyer profile: roles, place and buying signals, three different plays', () => {
  const s = playSuggestions({ sells: 'Online booking for dental practices', buyer: { who: ['Dental practice owners', 'Clinic administrators'], where: ['Ohio', 'Texas'], signals: ['opened a new location', 'hiring front-desk staff', 'switching practice software'] } })
  assert.deepEqual(s, { from: 'business', items: [
    'Dental practice owners in Ohio - opened a new location',
    'Clinic administrators in Ohio - hiring front-desk staff',
    'Dental practice owners in Ohio - switching practice software',
  ] })
})

test('a short buyer profile is topped up from what the workspace sells; no duplicates', () => {
  const s = playSuggestions({ sells: 'Online booking', buyer: { who: ['Dental practice owners'], signals: [] } })
  assert.equal(s.from, 'business')
  assert.deepEqual(s.items, ['Dental practice owners', 'Businesses that could use online booking - opened a new location', 'Businesses that could use online booking - hiring for a role this helps with'])
})

test('only what it sells: three plays built on it; acronyms keep their case; each fits the scan request cap', () => {
  assert.deepEqual(playSuggestions({ sells: 'CRM for roofers' }).items, [
    'Businesses that could use CRM for roofers - opened a new location',
    'Businesses that could use CRM for roofers - hiring for a role this helps with',
    'Businesses that could use CRM for roofers - complaining publicly about their current tool',
  ])
  assert.ok(playSuggestions({ sells: 'x'.repeat(900) }).items.every(i => i.length <= 600))
})
