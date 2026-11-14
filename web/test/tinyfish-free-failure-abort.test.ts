// #1046 (caller abort signal) x #1048 (free-failure settles at $0), combined after merging main into b/1037-lead-contact-person.
// A FREE TinyFish call aborted by the caller's signal (job reclaimed/cancelled, pass deadline) settles at $0: not maybe-billed, not a provider
// rejection, nothing left reserved, no hits returned. A PRICED call aborted mid-flight keeps the fail-closed rule (stays reserved, attempt stops paying).
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateTinyfish, tfSearch, tfFetch, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { runWithScanSpend, reserveScanSpend, scanCapConfig, spendAttemptUncertain, spendAttemptRejected, scanSpendCalls } from '../lib/scan/spend-cap.ts'

const T0 = 1_800_000_000
async function setup() {
  resetTinyfishState()
  const db = new Database(':memory:'); migrateScan(db); migrateTinyfish(db)
  const id = createQueryJob(db, 'A', { query: 'aborted free tinyfish' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?").run(id)
  return { db, id, ctx: () => ({ db, jobId: id, tenantId: 'A', attempt: 1, cap: scanCapConfig({}), accountLimits: null, clock: () => T0 }) }
}
// A request that hangs until its signal aborts, then rejects like real fetch does.
function hanging(seen: { aborted: boolean; started: number }) {
  return (async (_u: string, init?: RequestInit) => {
    seen.started++
    return new Promise<Response>((_res, rej) => {
      const s = init?.signal
      if (s?.aborted) { seen.aborted = true; rej(new DOMException('aborted', 'AbortError')); return }
      s?.addEventListener('abort', () => { seen.aborted = true; rej(new DOMException('aborted', 'AbortError')) })
    })
  }) as unknown as typeof fetch
}

for (const kind of ['search', 'fetch'] as const) {
  test(`free TinyFish ${kind} aborted in flight by the caller's signal: settled at $0, not maybe-billed, not rejected, no hits`, async () => {
    const s = await setup(); const seen = { aborted: false, started: 0 }; const ac = new AbortController()
    const deps = { env: { TINYFISH_API_KEY: 'k' }, fetchImpl: hanging(seen), now: T0, signal: ac.signal }
    const out = await runWithScanSpend(s.ctx(), async () => {
      const p = kind === 'fetch' ? tfFetch(s.db, 'A', ['https://a.example/x'], { fetches: 0 }, deps) : tfSearch(s.db, 'A', 'q', {}, { searches: 0 }, deps)
      setTimeout(() => ac.abort(), 5)
      const r = await p
      const next = await reserveScanSpend('render', () => 0.01)
      return { r, uncertain: spendAttemptUncertain(), rejected: spendAttemptRejected(), next }
    })
    assert.equal(seen.started, 1); assert.equal(seen.aborted, true, 'the in-flight request received the abort')
    assert.equal(out.r.ok, false); assert.equal('hits' in out.r || 'pages' in out.r, false, 'an aborted call returns no results')
    assert.equal(out.uncertain, false); assert.equal(out.rejected, null); assert.ok(out.next)
    const calls = (await scanSpendCalls(s.db, s.id, 'A')).filter(c => c.kind.startsWith('tinyfish.'))
    assert.equal(calls.length, 1); assert.equal(calls[0].status, 'settled'); assert.equal(calls[0].actual_usd, 0)
  })
}

test('free TinyFish search with an ALREADY-aborted signal: the request is cancelled, settled at $0, nothing reserved', async () => {
  const s = await setup(); const seen = { aborted: false, started: 0 }; const ac = new AbortController(); ac.abort()
  const out = await runWithScanSpend(s.ctx(), async () => {
    const r = await tfSearch(s.db, 'A', 'q', {}, { searches: 0 }, { env: { TINYFISH_API_KEY: 'k' }, fetchImpl: hanging(seen), now: T0, signal: ac.signal })
    return { r, uncertain: spendAttemptUncertain(), rejected: spendAttemptRejected() }
  })
  assert.equal(out.r.ok, false); assert.equal(seen.aborted, true); assert.equal(out.uncertain, false); assert.equal(out.rejected, null)
  const calls = (await scanSpendCalls(s.db, s.id, 'A')).filter(c => c.kind.startsWith('tinyfish.'))
  assert.equal(calls.length, 1); assert.equal(calls[0].status, 'settled'); assert.equal(calls[0].actual_usd, 0)
})

test('a PRICED TinyFish fetch aborted in flight keeps the fail-closed rule: maybe billed, stays reserved', async () => {
  const s = await setup(); const seen = { aborted: false, started: 0 }; const ac = new AbortController()
  const env = { TINYFISH_API_KEY: 'k', DAZL_SCAN_PRICE_TINYFISH_FETCH_USD: '0.01' }
  const out = await runWithScanSpend(s.ctx(), async () => {
    const p = tfFetch(s.db, 'A', ['https://a.example/x'], { fetches: 0 }, { env, fetchImpl: hanging(seen), now: T0, signal: ac.signal })
    setTimeout(() => ac.abort(), 5)
    await p
    return spendAttemptUncertain()
  })
  assert.equal(seen.aborted, true); assert.equal(out, true)
  assert.equal((await scanSpendCalls(s.db, s.id, 'A'))[0].status, 'reserved')
})
