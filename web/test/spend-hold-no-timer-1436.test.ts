// #1441 review (Ziggy, blocking): elapsed time never proves a paid call finished, so no hold is released by age.
// An old ACTIVE marker and an old UNATTRIBUTED marker still refuse new reservations, however old; the stuck hold on a
// real workspace is resolved by an operator with evidence (scripts/spend-marker.mts), never by a timer.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sharedPool, poolRows, migrateSpendPools } from '../lib/llm/spend-pool.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { sqliteDb } from '../lib/db/client.ts'

const T0 = Date.UTC(2026, 10, 20, 12) / 1000
const refused = (reason: string) => (e: unknown) => e instanceof SpendRefused && e.reason === reason

for (const [label, age] of [['one hour', 3600], ['one day', 86400], ['thirty days', 30 * 86400]] as const) {
  test(`an unattributed pending marker ${label} old still blocks, and its dollars stay held`, async () => {
    const raw = new Database(':memory:'); migrateSpendPools(raw)
    try {
      const db = sqliteDb(raw)
      let now = T0
      const p = sharedPool(db, 'W', { day: 50, month: 500 }, () => now, 0)
      await p.reserve(1.85, T0, 'abcdef0123')          // no linked call row: unattributed
      now = T0 + age
      await assert.rejects(p.reserve(0.1, now), refused('accounting_unsettled'))
      assert.ok((await poolRows(db, 'W')).some(r => r.period === 'p:abcdef0123' && r.reserved_usd === 1.85), 'marker kept, not renamed or freed')
    } finally { raw.close() }
  })
}
test('a known-failed marker still blocks however old', async () => {
  const raw = new Database(':memory:'); migrateSpendPools(raw)
  try {
    const db = sqliteDb(raw)
    let now = T0
    const p = sharedPool(db, 'F', { day: 50 }, () => now, 0)
    await p.reserve(0.5, T0, '0123abcdef'); await p.markFailed('0123abcdef')
    now = T0 + 30 * 86400
    await assert.rejects(p.reserve(0.1, now), refused('accounting_unsettled'))
  } finally { raw.close() }
})
