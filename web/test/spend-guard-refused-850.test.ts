// A base (per-job) SpendGuard that has been marked refused must refuse every later paid call, even with room under its
// arithmetic cap - the same rule PooledGuard already follows. Stub providers, no network, nothing billed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpendGuard, SpendRefused, SpendAccountingFailed, PooledGuard, guardProvider } from '../lib/llm/spend-guard.ts'
import type { CompletionUsage, Provider } from '../lib/llm/provider.ts'

const KEY = 'sk-test'
const MODEL = 'claude-sonnet-4-5'
const USAGE: CompletionUsage = { input_tokens: 100, output_tokens: 50 }

function stub(usage: () => CompletionUsage | undefined): { p: Provider; calls: () => number } {
  let n = 0
  const p: Provider = {
    research: async () => ({ text: '', citedUrls: [] }),
    completeDetailed: async () => { n++; return { text: 'ok', model: MODEL, usage: usage() } },
    configuredModel: () => MODEL,
  }
  return { p, calls: () => n }
}

test('#850: a no-usage completion makes the next paid call refuse through the SAME base guard, with room under its cap', async () => {
  const guard = new SpendGuard(5)
  const s = stub(() => undefined)
  const gp = guardProvider(s.p, guard, undefined, undefined, true)
  await gp.complete!(KEY, 'first', undefined, 100)
  assert.ok(guard.reservedUsd < guard.limitUsd, 'room is left under the arithmetic cap')
  await assert.rejects(gp.complete!(KEY, 'second', undefined, 100), SpendRefused)
  assert.equal(s.calls(), 1, 'the second paid call never reached the provider')
})

test('#850: after a cost that could not be recorded, the same base guard refuses even once its store works again', async () => {
  let saves = 0
  const guard = new SpendGuard(5)
  // the 1st save (reservation) works, the settle and its one retry fail, then the store is healthy again
  guard.persist = () => { saves++; if (saves === 2 || saves === 3) throw new Error('store down') }
  const s = stub(() => USAGE)
  const gp = guardProvider(s.p, guard, undefined, undefined, true)
  await assert.rejects(gp.complete!(KEY, 'first', undefined, 100), SpendAccountingFailed)
  await assert.rejects(gp.complete!(KEY, 'second', undefined, 100), SpendRefused)
  assert.equal(s.calls(), 1, 'no paid call after an unrecorded cost')
})

test('#850 control: with usage reported, the base guard settles each call and keeps admitting calls under its cap', async () => {
  const guard = new SpendGuard(5)
  const s = stub(() => USAGE)
  const gp = guardProvider(s.p, guard, undefined, undefined, true)
  for (let i = 0; i < 3; i++) await gp.complete!(KEY, `call ${i}`, undefined, 100)
  assert.equal(s.calls(), 3)
  assert.equal(guard.refused, false)
  assert.ok(Math.abs(guard.reservedUsd - 3 * (100 * 3 + 50 * 15) / 1e6) < 1e-12, 'each call settled to its reported cost')
})

test('#850 control: PooledGuard keeps refusing once refused (unchanged)', () => {
  const g = new PooledGuard({} as never)
  g.refused = true
  assert.throws(() => g.checkUsd(0.001), SpendRefused)
})
