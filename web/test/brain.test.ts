import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brainFacts } from '../lib/brain.ts'

test('the brain shows exactly what the website read returned, nothing more', () => {
  const f = brainFacts({ source: 'https://www.dazl.ai/', sells: 'Signal-based prospecting for small B2B teams', icp: { summary: 'B2B SaaS founders, 1-50 employees', who: ['Founder', 'Head of Sales', 'founder'], industries: ['B2B SaaS', 'Agencies'], where: ['US', 'UK'], sizes: ['1-50 employees'], signals: ['Hiring an SDR', 'Raised a seed round'], exclude: ['Enterprises'] } })
  assert.deepEqual(f.map(x => [x.label, x.text]), [
    ['Company', 'dazl.ai'], ['Product', 'Signal-based prospecting for small B2B teams'], ['Ideal customer', 'B2B SaaS founders, 1-50 employees'],
    ['Persona', 'Founder'], ['Persona', 'Head of Sales'], ['Industry', 'B2B SaaS'], ['Industry', 'Agencies'], ['Region', 'US'], ['Region', 'UK'],
    ['Company size', '1-50 employees'], ['Buying signal', 'Hiring an SDR'], ['Buying signal', 'Raised a seed round'], ['Skip', 'Enterprises'],
  ], 'duplicates dropped, order fixed, no invented kinds (competitors, voice, keywords are not inferred yet)')
  assert.deepEqual(brainFacts({}), [], 'an empty read shows no facts')
})
