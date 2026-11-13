// The operator's TinyFish budget is shared fairly across tenants (#1082): each tenant's share is the pool over the
// tenants active today (never below one full scan), the growth tenant keeps a reserved slice nobody else can use, the
// global cap is never passed even when tenants race for the last units, a share-limited call is recorded as
// "capacity" (thinner results), and over 80% used before 18:00 UTC alerts the operator once. Stub fetch; nothing is billed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { tfSearch, tfFetch, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { SearchTrace, summarizeTrace } from '../lib/search/trace.ts'
import { setErrorSinks } from '../lib/ops/errors.ts'
import type { Db } from '../lib/db/client.ts'

const NOON = Date.UTC(2026, 10, 12, 12) / 1000, EVENING = Date.UTC(2026, 10, 12, 19) / 1000
const okFetch = (async (u: string, init?: RequestInit) => {
  if (String(u).startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
  const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
  return new Response(JSON.stringify({ results: urls.map(url => ({ url, title: 't', text: 'x'.repeat(50) })) }), { status: 200 })
}) as unknown as typeof fetch
// global 30 fetch units, 10 per scan; tenant cap high so only the platform share binds
const ENV = { TINYFISH_API_KEY: 'k', TINYFISH_FETCHES_PER_SCAN: '10', TINYFISH_SEARCHES_PER_SCAN: '2', TINYFISH_TENANT_DAILY: '1000', TINYFISH_GLOBAL_FETCH_DAILY: '30', TINYFISH_GLOBAL_SEARCH_DAILY: '6', TINYFISH_PER_MINUTE: '1000' }
const urls = (n: number, p = 'a') => Array.from({ length: n }, (_, i) => `https://${p}${i}.example/page`)
const fetchUnits = async (db: Db, tenant: string, n: number, env: Record<string, string> = ENV, now = NOON, trace?: SearchTrace) => {
  const r = await tfFetch(db, tenant, urls(n, tenant), { fetches: 0 }, { env, now, fetchImpl: okFetch, trace })
  return r.ok ? r.pages.length : 0
}
const total = async (db: Db, kind = 'fetch') => Number((await db.get<{ n: number }>('SELECT COALESCE(SUM(n),0) AS n FROM tinyfish_usage WHERE kind = ?', [kind]))!.n)

bothEngines('#1082: a second tenant still gets its fair share after the first tenant ran hard (room is kept for one more tenant)', async ({ db }) => {
  await resetTinyfishState(db)
  const env = { ...ENV, TINYFISH_GLOBAL_FETCH_DAILY: '60' }
  // A alone: share = 60 / (0 + 2) = 30; first-come-first-served would let A take all 60
  for (let i = 0; i < 3; i++) assert.equal(await fetchUnits(db, 'A', 10, env), 10)
  assert.equal(await fetchUnits(db, 'A', 10, env), 0, 'A alone stops at half: room kept for the next tenant')
  // B arrives: B's share = 60 / (1 + 2) = 20 (room is still kept for a third tenant)
  assert.equal(await fetchUnits(db, 'B', 10, env), 10)
  assert.equal(await fetchUnits(db, 'B', 10, env), 10)
  assert.equal(await fetchUnits(db, 'B', 10, env), 0, 'B stops at its share; 10 units stay for the next tenant')
  assert.equal(await fetchUnits(db, 'C', 10, env), 10, 'a third tenant still finds room')
  assert.equal(await total(db), 60)
})

bothEngines('#1082: the issue\'s staging check: global 30, 25 fetches a scan, A runs two scans then B; B still gets a fair share', async ({ db }) => {
  await resetTinyfishState(db)
  const env = { ...ENV, TINYFISH_GLOBAL_FETCH_DAILY: '30', TINYFISH_FETCHES_PER_SCAN: '25' }
  const scan = async (t: string) => { const spent = { fetches: 0 }; let got = 0; for (let i = 0; i < 3; i++) { const r = await tfFetch(db, t, urls(10, `${t}${i}x`), spent, { env, now: NOON, fetchImpl: okFetch }); if (r.ok) got += r.pages.length } return got }
  const a1 = await scan('A'), a2 = await scan('A'), b1 = await scan('B'), b2 = await scan('B')
  assert.equal(a1 + a2, 15, `A: ${a1}+${a2}`)
  assert.equal(b1 + b2, 15, `B: ${b1}+${b2}`)
})

bothEngines('#1082: three tenants racing for the last units never pass the global cap', async ({ db }) => {
  await resetTinyfishState(db)
  const got = await Promise.all(['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C'].map(t => fetchUnits(db, t, 10)))
  assert.ok(got.reduce((a, b) => a + b, 0) <= 30, `admitted ${got.join(',')}`)
  assert.ok(await total(db) <= 30)
  for (const t of ['A', 'B', 'C']) assert.ok(Number((await db.get<{ n: number }>("SELECT COALESCE(SUM(n),0) AS n FROM tinyfish_usage WHERE tenant_id = ? AND kind = 'fetch'", [t]))!.n) > 0, `${t} got a share`)
})

bothEngines('#1082: the growth tenant keeps its reserved slice; other tenants cannot consume it', async ({ db }) => {
  await resetTinyfishState(db)
  const env = { ...ENV, DAZL_GROWTH_TENANT_ID: 'G', TINYFISH_GROWTH_RESERVE_PCT: '20' } // reserve 6 of 30; pool 24
  for (let i = 0; i < 6; i++) await fetchUnits(db, 'X', 10, env)
  for (let i = 0; i < 6; i++) await fetchUnits(db, 'Y', 10, env)
  assert.ok(await total(db) <= 24, 'others stop at the pool, never inside the reserve')
  assert.ok((await fetchUnits(db, 'G', 10, env)) >= 6, 'the growth tenant still gets at least its reserve')
  assert.ok(await total(db) <= 30)
})

bothEngines('#1082: a share-limited fetch is recorded as capacity (results are thinner), and a share-refused search returns cap to its caller', async ({ db }) => {
  await resetTinyfishState(db)
  const env = { ...ENV, TINYFISH_GLOBAL_FETCH_DAILY: '15', TINYFISH_FETCHES_PER_SCAN: '10' }
  assert.equal(await fetchUnits(db, 'A', 10, env), 7, 'A alone: half the pool (room kept for one more tenant)')
  const trace = new SearchTrace()
  assert.equal(await fetchUnits(db, 'B', 10, env, NOON, trace), 7, 'B is cut to its share')
  const s = summarizeTrace(trace)
  assert.equal(s.fetch_capacity_trimmed, 3, 'the 3 pages left out are counted as capacity')
  // searches: global 6; A uses its share, then the share refuses with 'cap' (callers stop) recorded as capacity
  const t2 = new SearchTrace()
  for (let i = 0; i < 8; i++) await tfSearch(db, 'A', `q${i}`, {}, { searches: 0 }, { env: ENV, now: NOON, fetchImpl: okFetch, trace: t2 })
  const r = await tfSearch(db, 'A', 'more', {}, { searches: 0 }, { env: ENV, now: NOON, fetchImpl: okFetch, trace: t2 })
  assert.deepEqual(r, { ok: false, reason: 'cap' })
  assert.ok((summarizeTrace(t2).searches_not_attempted.capacity ?? 0) > 0)
})

bothEngines('#1082: over 80% of a daily cap used before 18:00 UTC alerts the operator once that day (not once per call, not once per instance); after 18:00 it does not', async ({ db }) => {
  await resetTinyfishState(db)
  const env = { ...ENV, TINYFISH_GLOBAL_FETCH_DAILY: '100', TINYFISH_FETCHES_PER_SCAN: '1' }
  const T9 = ['A', 'B', 'C', 'D', 'E', 'F', 'H', 'I', 'J']
  const one = (t: string, now = NOON) => tfFetch(db, t, [`https://${t}${Math.random()}.example/p`], { fetches: 0 }, { env, now, fetchImpl: okFetch })
  const seen: string[] = []
  const off = setErrorSinks([r => { if (r.where === 'tinyfish:budget') seen.push(r.error.message) }])
  try {
    // 9 tenants, single-unit fetches (each one's share is 100 / 10 = 10, room kept for a tenth): up to 90 admitted,
    // the calls past 80 all above 80% of 100
    for (let i = 0; i < 95; i++) await one(T9[i % 9])
    assert.ok(await total(db) > 80, `fixture: over 80% used (${await total(db)})`)
    assert.equal(seen.filter(m => m.includes('fetch')).length, 1, 'one alert for the day, though several admitted calls were above 80%')
    assert.doesNotMatch(seen.join(' '), /example/, 'counts only')
  } finally { off() }
  // another instance (the day's key already written): no second alert
  await resetTinyfishState(db); await db.run('DELETE FROM tinyfish_usage')
  const day = new Date(NOON * 1000).toISOString().slice(0, 10)
  await db.run('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)', [`tinyfish:alert80:fetch:${day}`, (NOON + 86400) * 1000])
  const again: string[] = []
  const off2 = setErrorSinks([r => { if (r.where === 'tinyfish:budget') again.push(r.error.message) }])
  try { for (let i = 0; i < 95; i++) await one(T9[i % 9]); assert.equal(again.length, 0, 'the day already alerted') } finally { off2() }
  // after 18:00 UTC: no alert
  await resetTinyfishState(db); await db.run('DELETE FROM tinyfish_usage')
  const late: string[] = []
  const off3 = setErrorSinks([r => { if (r.where === 'tinyfish:budget') late.push(r.error.message) }])
  try { for (let i = 0; i < 95; i++) await one(T9[i % 9], EVENING); assert.ok(await total(db) > 80, 'fixture: over 80% used after 18:00'); assert.equal(late.length, 0) } finally { off3() }
})

test('#1082: the run report carries what the platform share left out, so the leads page can say results are thinner', async () => {
  const { buildRunReport } = await import('../lib/scan/run-report.ts')
  assert.deepEqual(buildRunReport({ capacity: { searches: 2, fetches: 5 } }, null, null, 1).capacity, { searches: 2, fetches: 5 })
  assert.equal(buildRunReport({}, null, null, 1).capacity, null, 'a run the share never limited says nothing')
})

test('#1082: /api/health/scheduler shows today\'s TinyFish platform totals only (no per-tenant use, no tenant ids); an unreadable usage table never changes the health status', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const { schedulerHealthResponse } = await import('../lib/ops/scheduler-runs.ts')
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const day = new Date(NOON * 1000).toISOString().slice(0, 10)
  const ins = raw.prepare('INSERT INTO tinyfish_usage (day, tenant_id, kind, n) VALUES (?, ?, ?, ?)')
  ins.run(day, 'tenant-secret-aaa', 'search', 5); ins.run(day, 'tenant-secret-aaa', 'fetch', 20); ins.run(day, 'tenant-secret-bbb', 'fetch', 7)
  ins.run('2000-01-01', 'old', 'fetch', 99) // another day never counts
  const body = await (await schedulerHealthResponse(raw, NOON)).json() as { ok: boolean; tinyfish_today: Record<string, unknown> & { search: { used: number }; fetch: { used: number } } }
  assert.equal(body.tinyfish_today.search.used, 5)
  assert.equal(body.tinyfish_today.fetch.used, 27)
  assert.equal('per_tenant' in body.tinyfish_today, false, 'the public route shows platform totals only')
  assert.doesNotMatch(JSON.stringify(body), /tenant-secret/, 'no tenant id leaves the public route')
  // the operator route's figures (app/api/internal/tinyfish-today): per active tenant, largest first, counts only
  const { tinyfishToday } = await import('../lib/search/tinyfish.ts')
  const { sqliteDb } = await import('../lib/db/client.ts')
  const ops = await tinyfishToday(sqliteDb(raw), NOON)
  assert.deepEqual(ops.per_tenant, [25, 7]); assert.equal(ops.active_tenants, 2); assert.doesNotMatch(JSON.stringify(ops), /tenant-secret/)
  // the operator route's auth is tested through its real handler: test/tinyfish-today-route-1082.test.ts
  // the usage table missing (an unmigrated store): the field is null, the health answer is the same as without it
  const bare = new Database(':memory:')
  const r = await schedulerHealthResponse(bare, NOON)
  assert.equal(r.status, 200)
  const j = await r.json() as { tinyfish_today: unknown; operational: { state: string } }
  assert.equal(j.tinyfish_today, null); assert.equal(j.operational.state, 'never_ran')
})

test('#1082: the status read sends capacity_note only when the latest run report says the platform share limited the run', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const { createQueryJob } = await import('../lib/scan/store.ts')
  const { buildRunReport, writeRunReport } = await import('../lib/scan/run-report.ts')
  const { readScanStatus } = await import('../lib/scan/status-read-service.ts')
  const { sqliteDb } = await import('../lib/db/client.ts')
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const note = async (capacity: { searches: number; fetches: number } | undefined) => {
    const job = createQueryJob(raw, 'T', { query: 'q' })
    writeRunReport(raw, job, 1, buildRunReport(capacity ? { capacity } : {}, null, null, 1), { DAZL_RUN_REPORT: '1' })
    return ((await readScanStatus(sqliteDb(raw), 'T', job)) as { capacity_note: string | null }).capacity_note
  }
  assert.equal(await note({ searches: 0, fetches: 3 }), 'Platform search capacity reached today: results are thinner.')
  assert.equal(await note({ searches: 2, fetches: 0 }), 'Platform search capacity reached today: results are thinner.')
  assert.equal(await note({ searches: 0, fetches: 0 }), null)
  assert.equal(await note(undefined), null, 'a run the share never limited says nothing')
})

bothEngines('#1082: racing tenants and the growth tenant: the reserve holds under concurrency and the global cap is never passed', async ({ db }) => {
  await resetTinyfishState(db)
  const env = { ...ENV, DAZL_GROWTH_TENANT_ID: 'G', TINYFISH_GROWTH_RESERVE_PCT: '20' } // reserve 6 of 30
  const order = ['A', 'A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'G', 'G', 'G']
  const got = await Promise.all(order.map(t => fetchUnits(db, t, 10, env)))
  const g = got.filter((_, i) => order[i] === 'G').reduce((x, y) => x + y, 0)
  assert.ok(g >= 6, `the growth tenant got its reserve: ${g}`)
  assert.ok(await total(db) <= 30, 'never past the global cap')
})

bothEngines('#1082: a blank TINYFISH_GROWTH_RESERVE_PCT keeps the default 20% reserve (Number(\'\') would be 0)', async ({ db }) => {
  await resetTinyfishState(db)
  const env = { ...ENV, DAZL_GROWTH_TENANT_ID: 'G', TINYFISH_GROWTH_RESERVE_PCT: '  ' }
  for (const t of ['A', 'A', 'A', 'A', 'A', 'A', 'B', 'B', 'B']) await fetchUnits(db, t, 10, env)
  assert.ok(await total(db) <= 24, 'others stop at the pool: the 6-unit reserve is kept')
  assert.ok((await fetchUnits(db, 'G', 10, env)) >= 6, 'the growth tenant still gets its reserve')
})

// Hermes-PC review at f144ccf1, finding 1: a share refusal records the units the share removed - what this scan's own
// caps would still allow (2 left of 10 per scan) - never every URL it asked for (10).
bothEngines('#1082: a share-refused fetch with 2 fetches left on the scan records 2 as capacity, not the 10 URLs asked for', async ({ db }) => {
  await resetTinyfishState(db)
  const env = { ...ENV, TINYFISH_GLOBAL_FETCH_DAILY: '15' }
  assert.equal(await fetchUnits(db, 'A', 10, env), 7, 'A uses its whole share (room kept for one more tenant)')
  const trace = new SearchTrace()
  const r = await tfFetch(db, 'A', urls(10, 'A2'), { fetches: 8 }, { env, now: NOON, fetchImpl: okFetch, trace })   // 8 of 10 per scan spent: 2 left
  assert.deepEqual(r, { ok: false, reason: 'cap' })
  assert.equal(summarizeTrace(trace).fetch_capacity_trimmed, 2)
})

// finding 3: the public health route's cost never grows with the number of active tenants, and the operator detail is bounded
test('#1082: the public totals are summed in SQL (no per-tenant rows read) and the operator view is bounded to the top 10 tenants plus a count', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const { schedulerHealthResponse } = await import('../lib/ops/scheduler-runs.ts')
  const { tinyfishToday, TINYFISH_TOP_TENANTS } = await import('../lib/search/tinyfish.ts')
  const { sqliteDb } = await import('../lib/db/client.ts')
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const day = new Date(NOON * 1000).toISOString().slice(0, 10)
  const ins = raw.prepare('INSERT INTO tinyfish_usage (day, tenant_id, kind, n) VALUES (?, ?, ?, ?)')
  for (let i = 1; i <= 25; i++) { ins.run(day, `t${i}`, 'fetch', i); ins.run(day, `t${i}`, 'search', 1) }
  ins.run(day, 'idle', 'fetch', 0)   // a zero row is not an active tenant
  const ops = await tinyfishToday(sqliteDb(raw), NOON)
  assert.equal(TINYFISH_TOP_TENANTS, 10)
  assert.deepEqual(ops.per_tenant, [26, 25, 24, 23, 22, 21, 20, 19, 18, 17], 'the 10 largest (fetch + search), largest first')
  assert.equal(ops.active_tenants, 25)
  assert.deepEqual([ops.fetch.used, ops.search.used], [325, 25])
  // every statement the public route runs against tinyfish_usage is an aggregate grouped by kind: no per-tenant rows
  const seen: string[] = []
  const spy = new Proxy(raw, { get(t, k) { if (k === 'prepare') return (sql: string) => { seen.push(sql); return t.prepare(sql) }; const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v } })
  const body = await (await schedulerHealthResponse(spy as never, NOON)).json() as { tinyfish_today: { fetch: { used: number } } }
  assert.equal(body.tinyfish_today.fetch.used, 325)
  const usage = seen.filter(q => /tinyfish_usage/.test(q))
  assert.ok(usage.length > 0, 'the route read the usage table')
  for (const q of usage) { assert.match(q, /SUM\(n\)/); assert.match(q, /GROUP BY kind/); assert.doesNotMatch(q, /tenant_id/) }
})

// minor: an explicit 0% reserve really is 0, and an unset value is the 20% default
bothEngines('#1082: TINYFISH_GROWTH_RESERVE_PCT=0 keeps no reserve; unset keeps the 20% default', async ({ db }) => {
  await resetTinyfishState(db)
  const zero = { ...ENV, DAZL_GROWTH_TENANT_ID: 'G', TINYFISH_GROWTH_RESERVE_PCT: '0' }
  for (const t of ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'C', 'C', 'C', 'C']) await fetchUnits(db, t, 10, zero)
  assert.equal(await total(db), 30, 'with no reserve the others can use the whole day')
  await db.run('DELETE FROM tinyfish_usage'); await resetTinyfishState(db)
  const unset = { ...ENV, DAZL_GROWTH_TENANT_ID: 'G' }
  for (const t of ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'C', 'C', 'C', 'C']) await fetchUnits(db, t, 10, unset)
  assert.ok(await total(db) <= 24, 'unset: the 6-unit (20%) reserve is kept')
})
