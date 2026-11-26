import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun } from '../lib/scan/price-estimate.ts'

test('1725 discovery estimate states the whole-scan 15 search limit and a soft usage estimate, with no model name (#1721)', () => {
  const estimate = estimateRun({ budget: null, payer: 'you', discoverLane: 'full' })
  const row = estimate.rows.find(r => r.id === 'claude_discover')
  assert.ok(row)
  assert.doesNotMatch(row.note, /Sonnet|Claude|Anthropic|model/i, 'plain words: no model name')
  assert.match(row.note, /at most 15 web searches for the whole scan/)
  assert.match(row.note, /estimate, not a billing limit/)
  assert.match(row.note, /15.*whole scan/)
})
