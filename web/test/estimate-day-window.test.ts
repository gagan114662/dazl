import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun } from '../lib/scan/price-estimate.ts'

// A run's max_usd is per run; today's pooled reservations come off the owner's day cap, not off max_usd.
const base = { payer: 'you' as const, companyFirst: true, hiringRequest: true }

test('day pool reservations do not exhaust a per-run max_usd while the owner day cap has room', () => {
  const e = estimateRun({ ...base, budget: { max_usd: 3.33 } as never, ownerCapUsd: 13.33, reservedUsd: 3.53, ownerMonthCapUsd: 100, reservedMonthUsd: 5.82 } as never)
  assert.equal(e.verdict.ok, true, e.verdict.message)
  assert.ok(Math.abs((e.cap.remaining_usd ?? 0) - 3.33) < 1e-9)
  assert.equal(e.cap.max_usd, 13.33)
})

test('owner day cap still binds when its room is below the run max', () => {
  const e = estimateRun({ ...base, budget: { max_usd: 3.33 } as never, ownerCapUsd: 13.33, reservedUsd: 13.33 } as never)
  assert.equal(e.verdict.ok, false)
  assert.equal(e.cap.remaining_usd, 0)
})
