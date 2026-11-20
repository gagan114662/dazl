// #1436 follow-up (live check on prod 70671839): "Review profile first" was refused forever with "A previous AI call's
// cost is unresolved" - a pending-settlement marker whose settle never landed wedges every later reservation of the
// workspace. After a bounded time (STUCK_RELEASE_S) the marker is released with a recorded reason: the call is kept at
// its full worst-case cost in the day/month windows (never refunded), the marker row is kept as 'r:<id>' (the record),
// and new calls can reserve again. Fresh markers and markers whose settle is KNOWN to have failed stay fail-closed.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sharedPool, poolRows, periodOf, migrateSpendPools, PENDING_STALE_S, STUCK_RELEASE_S } from '../lib/llm/spend-pool.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { sqliteDb } from '../lib/db/client.ts'

const T0 = Date.UTC(2026, 10, 20, 12) / 1000
const refused = (reason: string) => (e: unknown) => e instanceof SpendRefused && e.reason === reason
const setup = () => { const raw = new Database(':memory:'); migrateSpendPools(raw); return { raw, db: sqliteDb(raw) } }
const rows = async (db: ReturnType<typeof sqliteDb>, o: string) => Object.fromEntries((await poolRows(db, o)).map(r => [r.period, Math.round(r.reserved_usd * 100) / 100]))

test('a stuck unresolved cost is released after a bounded time, kept at its worst case, with a recorded reason', async () => {
  const { raw, db } = setup()
  try {
    let now = T0
    const p = sharedPool(db, 'W', { day: 5, month: 50 }, () => now, 0)
    await p.reserve(1.85, T0, 'abcdef0123')            // a call whose settle never landed
    now = T0 + PENDING_STALE_S + 1
    await assert.rejects(p.reserve(0.1, now), refused('accounting_unsettled'), 'still fail-closed while recent')
    now = T0 + STUCK_RELEASE_S + 1
    await p.reserve(0.1, now)                          // released: the workspace is no longer wedged
    const r = await rows(db, 'W')
    assert.equal(r[periodOf('day', T0)], 1.95, 'the stuck call stays counted at its full worst case')
    assert.equal(r['p:abcdef0123'], undefined, 'no pending marker left')
    assert.equal(r['r:abcdef0123'], 1.85, 'the release is recorded with the amount kept')
  } finally { raw.close() }
})

test('a fresh in-flight cost is not released (busy), and a known-failed settle stays refused', async () => {
  const { raw, db } = setup()
  try {
    let now = T0
    const p = sharedPool(db, 'W', { day: 5 }, () => now, 0)
    await p.reserve(0.5, T0, 'abcdef0123')
    now = T0 + 10
    await assert.rejects(p.reserve(0.1, now), refused('busy'))
    const f = sharedPool(db, 'F', { day: 5 }, () => now, 0)
    await f.reserve(0.5, now, '0123abcdef'); await f.markFailed('0123abcdef')
    now = T0 + STUCK_RELEASE_S * 10
    await assert.rejects(f.reserve(0.1, now), refused('accounting_unsettled'), 'a known failure is never released by time alone')
  } finally { raw.close() }
})
