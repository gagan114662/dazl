import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXAMPLE_PLAYS, playSuggestions } from '../lib/play-suggestions.ts'

test('an empty brain gets the three static examples, labelled as examples', () => {
  for (const p of [null, {}, { sells: '  ', buyer: null }, { buyer: { who: [], signals: ['x'] } }]) assert.deepEqual(playSuggestions(p), { business: [], examples: EXAMPLE_PLAYS })
})

test('a saved buyer profile: roles, place and buying signals, three different plays', () => {
  const s = playSuggestions({ sells: 'Online booking for dental practices', buyer: { who: ['Dental practice owners', 'Clinic administrators'], where: ['Ohio', 'Texas'], signals: ['opened a new location', 'hiring front-desk staff', 'switching practice software'] } })
  assert.deepEqual(s, { business: [
    'Dental practice owners in Ohio - opened a new location',
    'Clinic administrators in Ohio - hiring front-desk staff',
    'Dental practice owners in Ohio - switching practice software',
  ], examples: [] })
})

test('a short buyer profile is topped up from what the workspace sells; no duplicates', () => {
  const s = playSuggestions({ sells: 'Online booking', buyer: { who: ['Dental practice owners'], signals: [] } })
  assert.deepEqual(s.examples, [])
  assert.deepEqual(s.business, ['Dental practice owners', 'Businesses that could use online booking - opened a new location', 'Businesses that could use online booking - complaining publicly about their current tool'])
})

test('only what it sells (no buyer profile): concrete plays built on it, examples make three; acronyms keep their case; each fits the scan request cap', () => {
  assert.deepEqual(playSuggestions({ sells: 'CRM for roofers' }), { business: [
    'Businesses that could use CRM for roofers - opened a new location',
    'Businesses that could use CRM for roofers - complaining publicly about their current tool',
  ], examples: [EXAMPLE_PLAYS[0]] })
  assert.ok(playSuggestions({ sells: 'x'.repeat(900) }).business.every(i => i.length <= 600))
})

// Instinct #248: a sparse profile got "Dental practice owners in Ohio" under "From your business details".
test('a sparse profile: its own suggestion only under business details; the top-up is examples, kept apart', () => {
  const s = playSuggestions({ buyer: { who: ['UK school principals'], where: ['London'], industries: ['education'] } })
  assert.deepEqual(s, { business: ['UK school principals in London'], examples: EXAMPLE_PLAYS.slice(0, 2) })
  const sellsOnly = playSuggestions({ sells: 'Timetabling software', buyer: { who: ['UK school principals'], where: ['London'], industries: ['Education'] } })
  assert.deepEqual(sellsOnly.business, ['UK school principals in London', 'Education businesses that could use timetabling software in London - opened a new location', 'Education businesses that could use timetabling software in London - complaining publicly about their current tool'])
  assert.deepEqual(sellsOnly.examples, [])
  for (const p of [{ buyer: { who: ['A'] } }, { buyer: { who: ['A', 'B'] } }, { sells: 'x' }, { buyer: { who: ['A'], signals: ['s'] } }]) {
    const r = playSuggestions(p)
    assert.equal(r.business.length + r.examples.length, 3, JSON.stringify(p))
    assert.ok(r.business.every(b => !EXAMPLE_PLAYS.includes(b)), 'no example is ever labelled as the business')
  }
})

// Instinct (live page): with no buyer profile, a suggestion read "hiring for a role this helps with", naming no role.
test('no suggestion is ever a placeholder: every role or event it names is concrete', () => {
  const profiles = [null, { sells: 'Online booking for dental practices' }, { sells: 'CRM', buyer: null }, { sells: 'x', buyer: { who: ['A'], where: ['B'], industries: ['C'] } }, { buyer: { who: ['UK school principals'] } }]
  for (const p of profiles) {
    const r = playSuggestions(p)
    for (const t of [...r.business, ...r.examples]) assert.doesNotMatch(t, /\b(a role|this helps|something|someone|your (product|tool|service))\b/i, t)
  }
})
