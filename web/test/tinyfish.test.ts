import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTinyfish, tfSearch, tfFetch, tinyfishEnabled, parseQueries, toEvidence, resetTinyfishState } from '../lib/search/tinyfish.ts'

const env = { TINYFISH_API_KEY: 'tf-secret-xyz', TINYFISH_APPROVED_TENANTS: '[{"tenantId": "t1", "approvalRef": "MOCK TEST ONLY t1", "acceptsPossibleCharges": true, "expiresAt": 1800001000, "maxRequests": 1000}, {"tenantId": "t2", "approvalRef": "MOCK TEST ONLY t2", "acceptsPossibleCharges": true, "expiresAt": 1800001000, "maxRequests": 1000}]', TINYFISH_SEARCHES_PER_SCAN: '2', TINYFISH_TENANT_DAILY: '3' }
const mk = () => { const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState(); return db }
const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const NOW = 1_800_000_000

test('disabled without the env key; never calls out', async () => {
  const db = mk(); let called = false
  const r = await tfSearch(db, 't1', 'q query here', {}, { searches: 0 }, { env: {}, fetchImpl: (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch })
  assert.deepEqual(r, { ok: false, reason: 'disabled' }); assert.equal(called, false); assert.equal(tinyfishEnabled({}), false)
})

test('search sends the key only as a header, normalizes hits, drops non-https', async () => {
  const db = mk(); let url = ''; let hdr: Record<string, string> = {}
  const f = (async (u: string, i: RequestInit) => { url = u; hdr = i.headers as Record<string, string>; return new Response(JSON.stringify({ results: [{ url: 'https://a.example/x', title: 'A', snippet: 'Acme hires a VP of Sales', date: '2026-10-01T00:00:00Z' }, { url: 'http://b.example', title: 'B', snippet: 's' }] })) }) as unknown as typeof fetch
  const r = await tfSearch(db, 't1', 'sales hiring query', { afterDate: '2025-10-20' }, { searches: 0 }, { env, fetchImpl: f, now: NOW })
  assert.ok(r.ok && r.hits.length === 1 && r.hits[0].date === '2026-10-01')
  assert.ok(!url.includes('tf-secret') && hdr['X-API-Key'] === 'tf-secret-xyz' && url.includes('after_date=2025-10-20'))
})

test('caps: per scan and per tenant per day', async () => {
  const db = mk(); const f = ok({ results: [] }); const spent = { searches: 0 }
  assert.ok((await tfSearch(db, 't1', 'query number one', {}, spent, { env, fetchImpl: f, now: NOW })).ok)
  assert.ok((await tfSearch(db, 't1', 'query number two', {}, spent, { env, fetchImpl: f, now: NOW })).ok)
  assert.deepEqual(await tfSearch(db, 't1', 'query number three', {}, spent, { env, fetchImpl: f, now: NOW }), { ok: false, reason: 'cap' })
  assert.ok((await tfSearch(db, 't1', 'new scan query', {}, { searches: 0 }, { env, fetchImpl: f, now: NOW })).ok) // 3rd tenant call today
  assert.deepEqual(await tfSearch(db, 't1', 'fourth today query', {}, { searches: 0 }, { env, fetchImpl: f, now: NOW }), { ok: false, reason: 'cap' })
  assert.ok((await tfSearch(db, 't2', 'other tenant query', {}, { searches: 0 }, { env, fetchImpl: f, now: NOW })).ok) // tenants are independent
})

test('402 and 429 and 401 trip a breaker so no more calls are made', async () => {
  for (const [status, reason] of [[402, 'quota'], [429, 'rate'], [401, 'auth']] as const) {
    const db = mk(); let n = 0
    const f = (async () => { n++; return new Response('{}', { status }) }) as unknown as typeof fetch
    assert.deepEqual(await tfSearch(db, 't1', 'some query text', {}, { searches: 0 }, { env, fetchImpl: f, now: NOW }), { ok: false, reason })
    await tfSearch(db, 't1', 'some query again', {}, { searches: 0 }, { env, fetchImpl: f, now: NOW + 1 })
    assert.equal(n, 1)
  }
})

test('network failure and bad JSON mean unavailable, not a crash', async () => {
  const db = mk()
  const r = await tfSearch(db, 't1', 'some query text', {}, { searches: 0 }, { env, fetchImpl: (async () => { throw new Error('boom') }) as unknown as typeof fetch, now: NOW })
  assert.deepEqual(r, { ok: false, reason: 'unavailable' })
})

test('fetch counts URLs against caps and returns pages with text', async () => {
  const db = mk()
  const f = ok({ results: [{ url: 'https://a.example/x', title: 'A', text: 'Acme Robotics is hiring its first VP of Sales in Berlin.' }], errors: [{ url: 'https://z.example', error: 'x' }] })
  const r = await tfFetch(db, 't1', ['https://a.example/x', 'https://z.example'], { fetches: 0 }, { env, fetchImpl: f, now: NOW })
  assert.ok(r.ok && r.pages.length === 1)
})

test('queries parse with fallback; evidence prefers fetched text over snippet', () => {
  assert.deepEqual(parseQueries('nonsense', 'my request', 3), ['my request'])
  assert.deepEqual(parseQueries('["hiring vp sales berlin","hiring vp sales berlin","x"]', 'r', 3), ['hiring vp sales berlin'])
  const ev = toEvidence([{ url: 'https://a.example/x', title: 'T', snippet: 'short snippet that is long enough', date: null }], [{ url: 'https://a.example/x', title: 'Full', text: 'Full page text about Acme hiring a sales lead.' }])
  assert.equal(ev.length, 1); assert.ok(ev[0].quote.startsWith('Full page'))
})
