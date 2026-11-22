import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpendGuard, SpendRefused } from '../lib/llm/spend-guard.ts'
import { buyerFitWorstCaseUsd } from '../lib/scan/price-estimate.ts'

// Run af02437c: buyer_fit "call failed: spend_refused:ownership_lost". Buyer-fit runs after finish(); the job guard's persist refuses once the
// row is 'done'. PM ruling (4) A: reserve at most ONE buyer-fit call (the estimate's buyer_fit row) while still running; the post-finish call
// settles only against that reservation; any unreserved post-finish dispatch is still refused.
function guard() {
  let running = true; const saved: number[] = []
  const g = new SpendGuard(1, 0)
  g.persist = usd => { if (!running) throw new SpendRefused('ownership_lost'); saved.push(usd) }
  return { g, saved, finish: () => { running = false } }
}
test('(4)A: the buyer-fit reservation made while running pays the post-finish call; its settle needs no write', () => {
  const { g, saved, finish } = guard()
  const usd = buyerFitWorstCaseUsd('claude-sonnet-4-5')
  assert.ok(usd > 0 && usd < 0.1, String(usd))
  g.prepay(usd)
  assert.deepEqual(saved, [usd])
  finish()
  g.reserveUsd(usd * 0.6)          // the real call, within the prepaid amount: no new reservation is written
  g.settle(-usd * 0.2)             // it cost less: the persisted prepaid amount over-counts, never under
  assert.equal(g.reservedUsd, usd)
  assert.deepEqual(saved, [usd])
})
test('(4)A: an unreserved post-finish call is refused (ownership_lost), and the prepaid amount pays one call only', () => {
  const { g, finish } = guard()
  const usd = buyerFitWorstCaseUsd('claude-sonnet-4-5')
  finish()
  assert.throws(() => g.reserveUsd(0.001), (e: unknown) => e instanceof SpendRefused && e.reason === 'ownership_lost')
  const b = guard(); b.g.prepay(usd); b.finish()
  assert.throws(() => b.g.reserveUsd(usd * 2), (e: unknown) => e instanceof SpendRefused && e.reason === 'ownership_lost')   // larger than reserved
  b.g.reserveUsd(usd * 0.5); b.g.settle(0)
  assert.throws(() => b.g.reserveUsd(usd * 0.1), (e: unknown) => e instanceof SpendRefused && e.reason === 'ownership_lost') // a second call
})
