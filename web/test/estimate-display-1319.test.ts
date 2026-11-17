import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun, displayEstimate } from '../lib/scan/price-estimate.ts'
import { scanModelPrice } from '../lib/scan/spend-cap.ts'

// #1319 items 1+2: what a customer sees on the "What this run will use" box. A first-time trial search on prod showed raw
// env names (DAZL_PRICE_TINYFISH_*), the internal model id, a "Never run" research row, and $0.09 - $0.63 above the $0.30 trial cap.
const trial = () => estimateRun({ budget: { first5: true } as never, payer: 'trial', firstPlayPeopleSearches: 10, trialReserveUsd: 0.3, priceModel: scanModelPrice, env: {} })
const own = () => estimateRun({ budget: null, payer: 'you', priceModel: scanModelPrice, env: {} })
const shown = (e: ReturnType<typeof estimateRun>) => { const d = displayEstimate(e); return JSON.stringify([d.rows, d.assumptions, d.verdict]) }

test('AC-1 #1319: no environment variable name appears anywhere the estimate box shows (trial and own key)', () => {
  for (const e of [trial(), own()]) assert.doesNotMatch(shown(e), /DAZL_|_USD\b/)
})

test('AC-2 #1319: the internal model id is shown as a plain product name', () => {
  for (const e of [trial(), own()]) { const s = shown(e); assert.doesNotMatch(s, /claude-sonnet-4-5/); assert.match(s, /Claude Sonnet 4\.5/) }
})

test('AC-3 #1319: the never-run research fallback row is not shown', () => {
  for (const e of [trial(), own()]) assert.ok(!displayEstimate(e).rows.some(r => r.id === 'fallback_research'))
})

test('AC-4 #1319: a trial estimate never shows a total above the $0.30 per-scan trial cap, and says the trial stops there', () => {
  const e = trial(), d = displayEstimate(e)
  assert.ok(d.total.max <= 0.3 + 1e-9, `shown max ${d.total.max}`)
  assert.ok(d.total.min <= d.total.max)
  assert.match(d.total_note ?? '', /free trial stops each scan at \$0\.30/)
  // an own-key run is unchanged: total is the real sum, no note
  const o = own(); assert.deepEqual(displayEstimate(o).total, o.total); assert.equal(displayEstimate(o).total_note, null)
})
