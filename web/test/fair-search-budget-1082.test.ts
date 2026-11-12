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

bothEngines('#1082: over 80% of a daily cap used before 18:00 UTC alerts the operator once that day; after 18:00 it does not', async ({ db }) => {
  await resetTinyfishState(db)
  const seen: string[] = []
  const off = setErrorSinks([r => { if (r.where === 'tinyfish:budget') seen.push(r.error.message) }])
  try {
    for (let i = 0; i < 3; i++) await fetchUnits(db, ['A', 'B', 'C'][i], 10) // 30 of 30
    assert.equal(seen.filter(m => m.includes('fetch')).length, 1, 'one alert, not one per call')
    assert.doesNotMatch(seen.join(' '), /\b[A-C]\b.*example/, 'counts only')
  } finally { off() }
  await resetTinyfishState(db)
  const late: string[] = []
  const off2 = setErrorSinks([r => { if (r.where === 'tinyfish:budget') late.push(r.error.message) }])
  try {
    await db.run("DELETE FROM tinyfish_usage")
    for (let i = 0; i < 3; i++) await fetchUnits(db, ['A', 'B', 'C'][i], 10, ENV, EVENING)
    assert.equal(late.length, 0)
  } finally { off2() }
})

test('#1082: the run report carries what the platform share left out, so the leads page can say results are thinner', async () => {
  const { buildRunReport } = await import('../lib/scan/run-report.ts')
  assert.deepEqual(buildRunReport({ capacity: { searches: 2, fetches: 5 } }, null, null, 1).capacity, { searches: 2, fetches: 5 })
  assert.equal(buildRunReport({}, null, null, 1).capacity, null, 'a run the share never limited says nothing')
})
