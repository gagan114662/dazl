import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpendGuard, SpendRefused, reserveAllUsd } from '../lib/llm/spend-guard.ts'
import { buyerFitPrompt, BUYER_FIT_PROMPT_BYTES } from '../lib/scan/buyer-fit.ts'
import { buyerFitWorstCaseUsd } from '../lib/scan/price-estimate.ts'
import { callCostUsd } from '../lib/llm/spend-guard.ts'

// Qodo #1555 (a): a prepaid call goes through the guarded route (reserveAllUsd checks first); the prepayment must cover it there.
test('Qodo #1555 (a): a call within the prepaid amount reserves through reserveAllUsd at the limit', async () => {
  const g = new SpendGuard(0.036); g.prepay(0.036)
  await reserveAllUsd([g], 0.03)
  assert.equal(g.refused, false)
  await assert.rejects(reserveAllUsd([g], 0.01), SpendRefused, 'a second call is not prepaid and does not fit')
})
// (b): a prepayment that does not fit is refused WITHOUT latching the guard (a trial run is not held for it).
test('Qodo #1555 (b): a refused prepayment leaves the guard usable', () => {
  const g = new SpendGuard(0.05, 0.04)
  assert.throws(() => g.prepay(0.036), SpendRefused)
  assert.equal(g.refused, false)
  g.reserveUsd(0.005)
})
// (c): Uare.ai's home page is ~582KB; five such pages still give a prompt the prepaid worst case covers.
test('Qodo #1555 (c): five 582KB home pages are cut so the call fits the prepaid reservation', () => {
  const page = ('Uare.ai lets professionals sell services, courses and coaching online — café naïve résumé. ').repeat(6500)
  assert.ok(Buffer.byteLength(page) > 580_000)
  const items = Array.from({ length: 5 }, (_, i) => ({ n: i + 1, company: `Co ${i}`, homepage: page }))
  const p = buyerFitPrompt('B2B companies doing outbound sales; seller dazl', items)
  assert.ok(Buffer.byteLength(p) <= BUYER_FIT_PROMPT_BYTES, `${Buffer.byteLength(p)} bytes`)
  for (const m of ['claude-sonnet-4-5', 'claude-haiku-4-5']) assert.ok(callCostUsd(m, Buffer.byteLength(p), 600) <= buyerFitWorstCaseUsd(m), m)
  assert.equal((p.match(/HOME PAGE:/g) ?? []).length, 5, 'every company still gets its page')
})
