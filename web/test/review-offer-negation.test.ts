// Reviewer's negative control on PR #374 (synthetic wording): where a negation applies changes the offer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveOffer } from '../lib/scan/play-offer-text.ts'

test('moving negation to the other service changes the offer', () => {
  const e = effectiveOffer({ seller: 'SEO but not PPC', query: 'Selling PPC but not SEO to local businesses' }, 'SEO but not PPC')
  assert.equal(e.source, 'conflict')
  assert.equal(e.offer, null)
})
