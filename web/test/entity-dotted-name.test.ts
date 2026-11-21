import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyEvidence } from '../lib/scan/evidence.ts'
// Prod run 65b84dfb: Yahoo Finance "Nextech3D.ai appoints SaaS sales chief" was dropped as entity_mismatch: the company key splits the
// dot ("nextech3d ai") while the quote kept it ("nextech3d.ai").
const page = (title: string, quote: string) => ({ title, text: `Markets. ${quote} More news.`, retrievedAt: 0 }) as never
const cand = (company: string, excerpt: string) => ({ company, excerpt, source_url: 'https://finance.yahoo.com/news/x', event_date: '2026-11-10' }) as never
test('a dotted company name in the quote names the company', () => {
  const q = 'Nextech3D.ai Corporation appoints a SaaS sales chief to lead its enterprise growth this quarter.'
  assert.notEqual((verifyEvidence(cand('Nextech3D.ai', q), page('Markets news', q)) as { reason?: string }).reason, 'entity_mismatch')
})
test('another company is still a mismatch', () => {
  const q = 'Othertech.io Corporation appoints a SaaS sales chief to lead its enterprise growth this quarter.'
  assert.equal((verifyEvidence(cand('Nextech3D.ai', q), page('Markets news', q)) as { reason?: string }).reason, 'entity_mismatch')
})
test('review: an "Acme" lead is not named by "Acme.ai" (another company)', () => {
  const q = 'Acme.ai Corporation appoints a SaaS sales chief to lead its enterprise growth this quarter.'
  assert.equal((verifyEvidence(cand('Acme', q), page('Markets news', q)) as { reason?: string }).reason, 'entity_mismatch')
})
