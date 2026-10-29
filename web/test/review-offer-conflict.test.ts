// Reviewer's negative controls on PR #374 (synthetic wording): a near-match offer is a conflict to choose, not a match.
import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveOffer } from '../lib/scan/play-offer-text.ts'

test('REVIEW a materially different buyer-specific offer must require a choice', () => {
  const old = 'appointment software for dental practices'
  const e = effectiveOffer({ seller: old, query: 'Selling appointment software for veterinary practices to clinics in London' }, old)
  assert.equal(e.source, 'conflict'); assert.equal(e.offer, null)
})

test('REVIEW explicit withdrawal of outbound consulting must not keep offering it', () => {
  const old = 'CRM setup and outbound consulting'
  const e = effectiveOffer({ seller: old, query: 'Selling CRM setup but no outbound consulting to local businesses' }, old)
  assert.equal(e.source, 'conflict'); assert.equal(e.offer, null)
})

test('the same offer differing only in case and spacing stays recorded; reordered words are a choice', () => {
  const old = 'CRM setup and outbound consulting'
  assert.deepEqual(effectiveOffer({ seller: old, query: 'Selling CRM  Setup and outbound consulting to London startups' }, old), { offer: old, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: old, query: 'Selling outbound consulting and CRM setup to London startups' }, old).source, 'conflict')
})
