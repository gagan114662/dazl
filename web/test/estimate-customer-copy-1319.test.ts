// #1319: the "What this run will use" box shows customers plain copy (no env var names, no model id, no never-run
// research-fallback row), and a free-trial scan's shown total is clamped to the trial's per-scan cap with the line saying so.
// The estimate itself keeps the technical detail for the ack, the saved job estimate and logs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareActual, customerEstimateTotal, customerView, estimateRun } from '../lib/scan/price-estimate.ts'

const FIRST5 = { first5: true }
const shown = (v: ReturnType<typeof customerView>) => JSON.stringify(v)

test('#1319 item 1: no env var names, no model id, no research-fallback row in the customer view', () => {
  for (const e of [estimateRun({ budget: null, payer: 'you', env: {} }), estimateRun({ budget: FIRST5, payer: 'trial', firstPlayPeopleSearches: 4, env: {} }), estimateRun({ budget: null, payer: 'you', model: 'gpt-4.1', env: {} })]) {
    const v = customerView(e), s = shown(v)
    assert.doesNotMatch(s, /DAZL_[A-Z_]+/, s)
    assert.doesNotMatch(s, /claude-sonnet-4-5|gpt-4\.1/, s)
    assert.doesNotMatch(s, /Never run|research fallback/i, s)
    assert.ok(!v.rows.some(r => r.id === 'fallback_research'))
    assert.ok(v.rows.filter(r => r.id.startsWith('tinyfish') || r.id === 'people_search').every(r => r.unit_usd === 'included' || /^\$/.test(r.unit_usd)), s)
    assert.ok(v.rows.filter(r => ['search_query_writing', 'extraction', 'scoring'].includes(r.id)).every(r => r.provider === 'AI research'))
  }
  const own = customerView(estimateRun({ budget: null, payer: 'you', env: {} }))
  assert.equal(own.rows.find(r => r.id === 'tinyfish_search')!.unit_usd, 'included')
  assert.equal(own.rows.find(r => r.id === 'tinyfish_search')!.provider, 'Web search')
  assert.match(own.rows.find(r => r.id === 'extraction')!.unit_usd, /^\$3\.00 in \/ \$15\.00 out per 1M tokens$/)
  // the technical detail stays in the estimate (ack, saved job estimate, logs)
  const raw = estimateRun({ budget: null, payer: 'you', env: {} })
  assert.ok(raw.rows.some(r => r.id === 'fallback_research')); assert.match(raw.rows.find(r => r.id === 'extraction')!.unit_usd, /\(claude-sonnet-4-5\)$/)
})

test('#1319 item 2: a trial-eligible run shows a total clamped to the $0.30 cap and says so', () => {
  const e = estimateRun({ budget: null, payer: 'trial', trialReserveUsd: 0.3, env: {} })
  assert.ok(e.total.max > 0.3, `fixture must exceed the cap: ${e.total.max}`)
  const v = customerView(e)
  assert.ok(v.total.max <= 0.3 && v.total.min <= 0.3, JSON.stringify(v.total))
  assert.equal(v.trial_cap_line, 'Free trial scans stop at $0.30.')
  // own-key runs are not clamped and show no trial line
  const own = customerView(estimateRun({ budget: null, payer: 'you', trialReserveUsd: 0.3, env: {} }))
  assert.equal(own.trial_cap_line, null); assert.ok(own.total.max > 0.3)
})

test('#1319: the cost box renders the customer view, the clamped total and the trial line', () => {
  const src = readFileSync(new URL('../app/app/leads/estimate-confirm.tsx', import.meta.url), 'utf8')
  assert.match(src, /customerView\(est\)/)
  assert.match(src, /view\.rows\.map/); assert.doesNotMatch(src, /est\.rows\.map/)
  assert.match(src, /range\(view\.total\)/); assert.doesNotMatch(src, /range\(est\.total\)/)
  assert.match(src, /data-testid="estimate-trial-cap"/)
})


test('a completed trial scan shows the same capped projection as its confirmation; own-key projection is unchanged', () => {
  const total = { min: 0.09, max: 0.66 }
  const base = estimateRun({ budget: null, payer: 'trial', trialReserveUsd: 0.3, env: {} })
  const est = { ...base, total, rows: [{ ...base.rows[0], kind: 'model' as const, usd: total }] }
  const actual = { inputTokens: null, outputTokens: null, tokensComplete: false, reservedUsd: null, searches: null }
  assert.deepEqual(customerEstimateTotal(est), { min: 0.09, max: 0.3 })
  assert.deepEqual(compareActual(est, actual).estimate, customerView(est).total)
  assert.match(compareActual(est, actual).summary, /\$0\.09-\$0\.30/)
  assert.deepEqual(customerEstimateTotal({ ...est, payer: 'you' }), total)
})
