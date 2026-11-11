// A TinyFish call priced $0 (free allowance) that fails does not end the scan as accounting_uncertain (staging trial-cap test, scan 3,
// 2026-11-10: one failed free page fetch killed the whole run and discarded its results). Approved by the owner 2026-11-11: ONLY free TinyFish
// search/fetch. A priced call, any other kind, and a 402 (billing error) keep the fail-closed rule; every spend cap stays on.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateTinyfish, tfSearch, tfFetch, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { runWithScanSpend, reserveScanSpend, scanCapConfig, spendAttemptUncertain, scanSpendCalls } from '../lib/scan/spend-cap.ts'

const T0 = 1_800_000_000
async function setup() {
  resetTinyfishState()
  const db = new Database(':memory:'); migrateScan(db); migrateTinyfish(db)
  const id = createQueryJob(db, 'A', { query: 'free tinyfish failure' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?").run(id)
  return { db, id, ctx: () => ({ db, jobId: id, tenantId: 'A', attempt: 1, cap: scanCapConfig({}), clock: () => T0 }) }
}
const FAILS: [string, () => Response][] = [
  ['5xx', () => new Response('{}', { status: 503 })],
  ['dropped connection', () => { throw new TypeError('socket hang up') }],
  ['200 with an unreadable body', () => new Response('not json', { status: 200 })],
]
for (const kind of ['fetch', 'search'] as const) for (const [name, ans] of FAILS) {
  test(`free TinyFish ${kind}, ${name}: a failed result, the scan may continue, nothing left reserved`, async () => {
    const s = await setup()
    const env = { TINYFISH_API_KEY: 'k' }, f = (async () => ans()) as unknown as typeof fetch
    const out = await runWithScanSpend(s.ctx(), async () => {
      const r = kind === 'fetch' ? await tfFetch(s.db, 'A', ['https://a.example/x'], { fetches: 0 }, { env, fetchImpl: f, now: T0 }) : await tfSearch(s.db, 'A', 'q', {}, { searches: 0 }, { env, fetchImpl: f, now: T0 })
      return { r, uncertain: spendAttemptUncertain() }
    })
    assert.equal(out.r.ok, false)
    assert.equal(out.uncertain, false, 'the attempt is not marked maybe-billed')
    const calls = await scanSpendCalls(s.db, s.id, 'A')
    assert.equal(calls.length, 1); assert.equal(calls[0].status, 'settled'); assert.equal(calls[0].actual_usd, 0)
    // the next paid call in the same attempt is still allowed
    assert.ok(await runWithScanSpend(s.ctx(), () => reserveScanSpend('render', () => 0.01)))
  })
}
test('a PRICED TinyFish call that fails keeps the fail-closed rule (maybe billed, stays reserved, attempt stops paying)', async () => {
  const s = await setup()
  const env = { TINYFISH_API_KEY: 'k', DAZL_SCAN_PRICE_TINYFISH_FETCH_USD: '0.01' }
  const f = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
  const out = await runWithScanSpend(s.ctx(), async () => { await tfFetch(s.db, 'A', ['https://a.example/x'], { fetches: 0 }, { env, fetchImpl: f, now: T0 }); return spendAttemptUncertain() })
  assert.equal(out, true)
  assert.equal((await scanSpendCalls(s.db, s.id, 'A'))[0].status, 'reserved')
})
test('a free TinyFish call answered 402 (billing error) is still maybe billed', async () => {
  const s = await setup()
  const f = (async () => new Response('{}', { status: 402 })) as unknown as typeof fetch
  const out = await runWithScanSpend(s.ctx(), async () => { await tfSearch(s.db, 'A', 'q', {}, { searches: 0 }, { env: { TINYFISH_API_KEY: 'k' }, fetchImpl: f, now: T0 }); return spendAttemptUncertain() })
  assert.equal(out, true)
})
test('a free TinyFish call that SUCCEEDS is unchanged: settled at $0', async () => {
  const s = await setup()
  const f = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch
  await runWithScanSpend(s.ctx(), () => tfSearch(s.db, 'A', 'q', {}, { searches: 0 }, { env: { TINYFISH_API_KEY: 'k' }, fetchImpl: f, now: T0 }))
  const c = await scanSpendCalls(s.db, s.id, 'A'); assert.equal(c[0].status, 'settled'); assert.equal(c[0].actual_usd, 0)
})
test('documented rejections (401/403/429) on a free call keep their own handling: the attempt records the rejection', async () => {
  const { spendAttemptRejected } = await import('../lib/scan/spend-cap.ts')
  for (const status of [401, 403, 429]) {
    const s = await setup()
    const f = (async () => new Response('{}', { status })) as unknown as typeof fetch
    const out = await runWithScanSpend(s.ctx(), async () => { await tfFetch(s.db, 'A', ['https://a.example/x'], { fetches: 0 }, { env: { TINYFISH_API_KEY: 'k' }, fetchImpl: f, now: T0 }); return { rej: spendAttemptRejected(), unc: spendAttemptUncertain() } })
    assert.equal(out.rej, status, String(status)); assert.equal(out.unc, false)
  }
})
