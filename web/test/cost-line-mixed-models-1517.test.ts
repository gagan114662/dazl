import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun, compareActual } from '../lib/scan/price-estimate.ts'
import { costPerShownLead } from '../lib/scan/cost-per-verification-pass.ts'

// Run af02437c (Refs #1517): sonnet-4-5 + haiku-4-5. The per-call ledger settled $0.74 ("Final cost" had it), yet the page said the
// stored sums "cannot be priced as one total ... unknown, not $0" and the per-lead line "model cost not recorded".
test('#1517: a 2-model job shows the summed settled ledger cost as the actual model cost, never "unknown", and per-lead uses it', () => {
  const est = estimateRun({ budget: null, payer: 'you' })
  const a = compareActual(est, { inputTokens: 120000, outputTokens: 9000, tokensComplete: true, model: 'claude-sonnet-4-5-20250929', servedModels: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
    searches: 4, reservedUsd: null, requests: 14, requestsWithTokens: 14, finalUsd: 0.74, finalHeldSteps: 0 })
  assert.equal(a.model_usd, 0.74)
  assert.doesNotMatch(a.summary, /unknown|cannot be priced/i)
  assert.match(a.summary, /\$0\.74/)
  const per = costPerShownLead({ model_usd: a.model_usd, scanEnded: true, leads: [{ review_reason: null }, { review_reason: null }], showSeen: false, leadsRead: true })
  assert.equal(per?.unavailable, null); assert.equal(per?.usd_per_lead, 0.37)
})
test('#1517: without a settled ledger total the mixed sums are still never priced at one model rate', () => {
  const est = estimateRun({ budget: null, payer: 'you' })
  const a = compareActual(est, { inputTokens: 120000, outputTokens: 9000, tokensComplete: true, model: 'claude-sonnet-4-5', servedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'], searches: 4, reservedUsd: null, requests: 14, requestsWithTokens: 14 })
  assert.equal(a.model_usd, null)
})
