import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun } from '../lib/scan/price-estimate.ts'

test('1725 discovery estimate names actual Sonnet, whole-scan15 and soft token estimate', () => {
  const estimate = estimateRun({ budget: null, payer: 'you', discoverLane: 'full' })
  const row = estimate.rows.find(r => r.id === 'claude_discover')
  assert.ok(row)
  assert.match(row.note, /Sonnet 5\.5/)
  assert.match(row.note, /15.*whole scan/)
  assert.match(row.note, /soft estimate/)
})
