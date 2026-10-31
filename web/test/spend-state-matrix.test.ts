// The owner spend pool as one state machine (lib/llm/spend-pool.ts + spend-guard.ts via lib/llm/owner-guard.ts, #363):
// for every state a paid completion can end in, how many provider calls were made, what the pool rows hold, whether
// the owner's NEXT call is admitted (from a fresh guard, another path or another connection), and what a qualification
// claim is left as. Synthetic owners and keys; every provider is a stub that counts calls. Nothing is billed.
//
//   state                          calls  pool after                         next call                 qualification claim
//   refused before the call          0    nothing written                    admitted if it fits       released (no call made)
//   settled under the cap            1    reported cost, no marker           admitted                  done
//   settled past the cap (cache)     1    reported cost > cap                refused over_limit        done
//   another call in flight           1    first call's reservation + marker  waits, then admitted      -
//                                                                            (or refused busy)
//   no usage reported                1    worst-case reservation stands      admitted                  done
//   unpriced served model / invalid  1    day = cap, month = reservation     refused over_limit        done
//   provider error                   1    worst-case reservation stands      admitted                  failed (kept)
//   settle row missing (no-op save)  1    reservation + marker marked failed refused unsettled          failed (kept)
//   store down during settle,        1    reservation + marker               refused at once, any      failed (kept)
//     then back                                                              connection
//   crash between call and settle    1    reservation + marker               busy, then unsettled      running (kept)
//   settle retried                   1    moved once                         -                         -
//   reserved before midnight,        1    settles on the reserved day        new day admitted          -
//     settled after
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { ownerGuarded } from '../lib/llm/owner-guard.ts'
import { poolRows, sharedPool, PENDING_STALE_S } from '../lib/llm/spend-pool.ts'
import { SpendAccountingFailed } from '../lib/llm/spend-guard.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb, type Db, type DbLike } from '../lib/db/client.ts'
import type { CompletionUsage, Provider } from '../lib/llm/provider.ts'

const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const MODEL = 'claude-sonnet-4-5'
const USAGE = { input_tokens: 100, output_tokens: 50 }
const USAGE_USD = (100 * 3 + 50 * 15) / 1e6
const CACHE = { input_tokens: 1000, output_tokens: 600, cache_creation_input_tokens: 40000 }
const CACHE_USD = (1000 * 3 + 600 * 15 + 40000 * 3 * 2) / 1e6
const env = (owner: string, day = 5, wait = 0) => ({ DAZL_RUN_MAX_USD_USERS: `${owner}:${day}`, DAZL_OWNER_MONTH_MAX_USD_USERS: `${owner}:50`, DAZL_SPEND_BUSY_WAIT_MS: String(wait) })

let calls = 0
function stub(answer: () => Promise<{ model: string | null; usage?: CompletionUsage }> | { model: string | null; usage?: CompletionUsage }): Provider {
  return { research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL, completeDetailed: async () => { calls++; const a = await answer(); return { text: 'ok', model: a.model, ...(a.usage ? { usage: a.usage } : {}) } } }
}
const call = (d: DbLike, owner: string, p: Provider, e = env(owner)) => ownerGuarded(d, owner, p, e).completeDetailed!(KEY, 'hello', undefined, 100)
const ok = stub(() => ({ model: MODEL, usage: USAGE }))
const view = async (db: Db, owner: string) => (await poolRows(db, owner)).map(r => [r.period.startsWith('p:') ? (Number(r.updated_at) === 0 ? 'p:failed' : 'p:open') : r.period.slice(0, 2), Math.round(r.reserved_usd * 1e6) / 1e6, Math.round(r.reported_usd * 1e6) / 1e6])
const refused = (reason: string) => new RegExp(`spend_refused:${reason}`)
const worst = async (db: Db, owner: string) => Number((await poolRows(db, owner)).find(r => r.period.startsWith('d:'))!.reserved_usd)

bothEngines('matrix: refused before the call / settled under the cap / settled past it / no usage / unknown cost', async ({ db }) => {
  calls = 0
  // Refused before the call: nothing written, no call; a call that fits is still admitted.
  await assert.rejects(call(db, 'R', ok, env('R', 0.0001)), refused('over_limit'))
  assert.deepEqual([calls, await view(db, 'R')], [0, []])
  // Settled under the cap: the reported cost, no marker; next admitted.
  await call(db, 'S', ok)
  assert.deepEqual(await view(db, 'S'), [['d:', USAGE_USD, USAGE_USD], ['m:', USAGE_USD, USAGE_USD]])
  await call(db, 'S', ok)
  assert.equal(calls, 2)
  // Past the cap (cache writes): recorded past it; next refused.
  await call(db, 'O', stub(() => ({ model: MODEL, usage: CACHE })), env('O', 0.05))
  assert.deepEqual(await view(db, 'O'), [['d:', CACHE_USD, CACHE_USD], ['m:', CACHE_USD, CACHE_USD]])
  await assert.rejects(call(db, 'O', ok, env('O', 0.05)), refused('over_limit'))
  assert.equal(calls, 3)
  // No usage: the worst case stands, no billed figure; next admitted.
  await call(db, 'N', stub(() => ({ model: MODEL })))
  const w = await worst(db, 'N')
  assert.ok(w > USAGE_USD); assert.deepEqual(await view(db, 'N'), [['d:', Math.round(w * 1e6) / 1e6, 0], ['m:', Math.round(w * 1e6) / 1e6, 0]])
  await call(db, 'N', ok)
  // Unknown cost (unpriced served model; invalid counts): the day is spent, the month holds the reservation; next refused.
  for (const [owner, usage, model] of [['U1', USAGE, 'claude-unlisted'], ['U2', { input_tokens: -1, output_tokens: 5 }, MODEL]] as const) {
    await call(db, owner, stub(() => ({ model, usage })))
    const [d, m] = await view(db, owner)
    assert.deepEqual([d[0], d[1], m[0], (m[1] as number) < 1], ['d:', 5, 'm:', true])
    await assert.rejects(call(db, owner, ok), refused('over_limit'))
  }
  assert.equal(calls, 7)
  // A requested model without a listed price: refused before any call.
  await assert.rejects(ownerGuarded(db, 'P', { ...ok, configuredModel: () => 'claude-unlisted' }, env('P')).completeDetailed!(KEY, 'hi', undefined, 10), refused('model_unpriced'))
  assert.equal(calls, 7)
})

bothEngines('matrix: a call in flight holds the owner; the next waits for it to settle, or is refused busy - never runs beside it', async ({ db }) => {
  calls = 0
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  const first = call(db, 'C', stub(async () => { await held; return { model: MODEL, usage: CACHE } }), env('C', 0.05))
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual((await view(db, 'C')).map(r => r[0]), ['d:', 'm:', 'p:open'])
  // Another path, no wait: refused while the first is unsettled; no call.
  await assert.rejects(call(db, 'C', ok, env('C', 0.05, 0)), refused('busy'))
  // Another path that waits: admitted only once the first settled, and then judged on the settled cost (an overrun).
  const second = call(db, 'C', ok, env('C', 0.05, 5000))
  await new Promise(r => setTimeout(r, 150))
  assert.equal(calls, 1, 'the second has not run beside the first')
  release()
  await first
  await assert.rejects(second, refused('over_limit'))
  assert.equal(calls, 1)
  // Under a bigger cap the waiting call runs after the first settled.
  let release2!: () => void
  const held2 = new Promise<void>(r => { release2 = r })
  const a = call(db, 'D', stub(async () => { await held2; return { model: MODEL, usage: USAGE } }))
  await new Promise(r => setTimeout(r, 50))
  const b = call(db, 'D', ok, env('D', 5, 5000))
  setTimeout(release2, 100)
  await Promise.all([a, b])
  assert.deepEqual((await view(db, 'D')).map(r => r.slice(0, 2)), [['d:', 2 * USAGE_USD], ['m:', 2 * USAGE_USD]])
  assert.equal(calls, 3)
})

bothEngines('matrix: provider error keeps the reservation and admits the next; a settle on a missing row fails closed for every caller', async ({ db }) => {
  calls = 0
  await assert.rejects(call(db, 'E', stub(() => { throw new Error('provider_500') })), /provider_500/)
  const w = await worst(db, 'E')
  assert.deepEqual((await view(db, 'E')).map(r => r[0]), ['d:', 'm:'], 'uncertain charge: the worst case stays, the marker is cleared')
  assert.ok(w > 0)
  await call(db, 'E', ok)
  // Settle hits a missing window row (the day row removed under the call): no silent no-op.
  await assert.rejects(call(db, 'M', stub(async () => { await db.run("DELETE FROM tenant_spend_pools WHERE tenant_id = 'M' AND period LIKE 'd:%'"); return { model: MODEL, usage: USAGE } })), SpendAccountingFailed)
  assert.deepEqual((await view(db, 'M')).map(r => r[0]), ['m:', 'p:failed'])
  await assert.rejects(call(db, 'M', ok), refused('accounting_unsettled'))
  assert.equal(calls, 3)
})

bothEngines('matrix: a settle retry moves once; a reservation made before midnight settles on that day, the new day admits', async ({ db }) => {
  const day1 = Date.UTC(2026, 9, 30, 23, 59, 59) / 1000
  let now = day1
  const p = sharedPool(db, 'T', { day: 1, month: 5 }, () => now, 0)
  await p.reserve(0.2, now, 'aaaaaaaaaa')
  now = day1 + 31 // 00:00:30 the next day
  await p.settle(-0.1, 0.1, day1, 'aaaaaaaaaa')
  await p.settle(-0.1, 0.1, day1, 'aaaaaaaaaa') // the retry
  assert.deepEqual((await poolRows(db, 'T')).map(r => [r.period, Math.round(r.reserved_usd * 1e6) / 1e6, Math.round(r.reported_usd * 1e6) / 1e6]), [['d:2026-10-30', 0.1, 0.1], ['m:2026-10', 0.1, 0.1]])
  await p.reserve(0.95, now)
  assert.deepEqual((await poolRows(db, 'T')).map(r => r.period), ['d:2026-10-30', 'd:2026-10-31', 'm:2026-10'], 'the new day has its own row')
})

// Two connections to one SQLite file stand in for two app instances (Instinct's reproduction on #466).
function twoConnections() {
  const dir = mkdtempSync(join(tmpdir(), 'dazl-spend-'))
  const file = join(dir, 'db.sqlite')
  const a = new Database(file); migrateAllSqlite(a)
  const b = new Database(file)
  for (const h of [a, b]) h.pragma('busy_timeout = 2000')
  return { a, b, done: () => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('matrix: store down during the settle, then back: another connection is refused at once, before this process writes anything', () => new Promise<void>((resolve, reject) => { void (async () => {
  const { a, b, done } = twoConnections()
  try {
    calls = 0
    await assert.rejects(call(a, 'A', stub(() => { a.exec('ALTER TABLE tenant_spend_pools RENAME TO tsp_down'); return { model: MODEL, usage: USAGE } })), SpendAccountingFailed)
    a.exec('ALTER TABLE tsp_down RENAME TO tenant_spend_pools')
    // Immediately, on the other connection, no flush, no timer: the open marker refuses.
    await assert.rejects(call(b, 'A', ok), refused('busy'))
    await assert.rejects(call(b, 'A', ok, env('A', 5, 300)), refused('busy'), 'still refused after waiting')
    // Once the first connection's retry has written the failure, it reads as unsettled for good.
    assert.equal(await sharedPool(a, 'A', { day: 5 }).flushFailed(), true)
    await assert.rejects(call(b, 'A', ok), refused('accounting_unsettled'))
    assert.equal(calls, 1)
    assert.deepEqual((await view(sqliteDb(b), 'A')).map(r => r[0]), ['d:', 'm:', 'p:failed'], 'the uncertain reservation is kept')
    resolve()
  } catch (e) { reject(e) } finally { done() }
})() }))

test('matrix: a crash between the call and its settle: the marker survives a restart, busy while fresh, unsettled once stale', async () => {
  const { a, b, done } = twoConnections()
  try {
    calls = 0
    // The process dies after reserving (the provider never returns to it): simulate with a reservation and no settle.
    await sharedPool(a, 'K', { day: 5 }).reserve(0.01, undefined, 'bbbbbbbbbb')
    a.close()
    await assert.rejects(call(b, 'K', ok), refused('busy'))
    b.prepare("UPDATE tenant_spend_pools SET updated_at = updated_at - ? WHERE tenant_id = 'K' AND period LIKE 'p:%'").run(PENDING_STALE_S + 1)
    await assert.rejects(call(b, 'K', ok), refused('accounting_unsettled'))
    assert.equal(calls, 0)
  } finally { try { done() } catch { /* a already closed */ } }
})

bothEngines('matrix: a scan-runner reservation (no marker of its own) waits for an owner call in flight, then proceeds', async ({ db }) => {
  const pool = sharedPool(db, 'W', { day: 5 })
  await pool.reserve(0.01, undefined, 'cccccccccc') // an ownerGuarded call in flight
  const runner = sharedPool(db, 'W', { day: 5 }, undefined, 5000).reserve(0.02)
  setTimeout(() => { void pool.settle(-0.005, 0.005, pool.now(), 'cccccccccc') }, 150)
  await runner
  assert.deepEqual((await view(db, 'W')).map(r => r.slice(0, 2)), [['d:', 0.025]])
  // With nothing settling it in time, the runner's reservation is refused (the scan stops as budget_stopped).
  await pool.reserve(0.01, undefined, 'dddddddddd')
  await assert.rejects(sharedPool(db, 'W', { day: 5 }, undefined, 200).reserve(0.02), refused('busy'))
})
