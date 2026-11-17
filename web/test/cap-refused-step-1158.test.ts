import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyLeadsMessage } from '../lib/scan/leads-view.ts'
import { compareActual } from '../lib/scan/price-estimate.ts'

// #1158: a run whose paid step was refused by its own spending limit finished "done" and read like an ordinary low-fit scan.
const est = { total: { min: 0.05, max: 0.09 }, rows: [{ id: 'model', kind: 'model', label: 'AI research', usd: { min: 0.05, max: 0.09 } }] } as never

test('#1158 AC1: the cost line names the refused step and the run limit', () => {
  const a = compareActual(est, { inputTokens: 100, outputTokens: 50, tokensComplete: true, model: 'claude-sonnet-4-5', searches: 2, reservedUsd: null, capReservedUsd: 0.04, capRefusals: 1, capUsd: 0.093 })
  assert.match(a.summary, /1 paid step was refused by this run's spending limit of \$0\.093/)
  assert.match(a.summary, /raising the limit would let it run/i)
})

test('#1158 AC1b: no refusal, no extra sentence', () => {
  const a = compareActual(est, { inputTokens: 100, outputTokens: 50, tokensComplete: true, model: 'claude-sonnet-4-5', searches: 2, reservedUsd: null, capReservedUsd: 0.04, capRefusals: 0, capUsd: 0.093 })
  assert.doesNotMatch(a.summary, /refused by this run's spending limit/)
})

test('#1158 AC2: hidden leads after a refused step are not called low fit', () => {
  const m = emptyLeadsMessage('done', 0, 3, 10, 0, 1)
  assert.ok(m)
  assert.doesNotMatch(m!, /fit bar|lower-fit/)
  assert.match(m!, /spending limit refused a paid step/)
  assert.match(m!, /3 hidden leads may not have been graded/)
})

test('#1158 AC3: without a refusal the existing copy is unchanged', () => {
  assert.equal(emptyLeadsMessage('done', 0, 2, null, 0, 0), 'The scan found nothing above your fit bar - 2 lower-fit leads are hidden below.')
})
