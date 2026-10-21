import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateIndexing, saveDomain, getConfig, addKeyword, removeKeyword, listKeywords, runIndexChecks, latestResults, weeklySpend, dueTenants, WEEKLY_ALLOWANCE } from '../lib/seo/indexing.ts'
import { migrateTinyfish, resetTinyfishState } from '../lib/search/tinyfish.ts'

const NOW = 1_800_000_000
const env = { TINYFISH_API_KEY: 'tf-key' }
function setup() { const db = new Database(':memory:'); migrateTinyfish(db); migrateIndexing(db); resetTinyfishState(); return db }
const hits = (urls: string[]) => (async () => new Response(JSON.stringify({ results: urls.map(u => ({ url: u, title: 't', snippet: 'a long enough snippet for the test', date: '2027-01-01' })) }), { status: 200 })) as unknown as typeof fetch

test('config and keywords: save, cap at 10, remove', () => {
  const db = setup()
  assert.equal(saveDomain(db, 'u1', 'https://www.acme.com/path'), 'acme.com')
  assert.deepEqual(getConfig(db, 'u1')?.domain, 'acme.com')
  for (let i = 0; i < 10; i++) assert.deepEqual(addKeyword(db, 'u1', `keyword ${i}`), { ok: true })
  assert.deepEqual(addKeyword(db, 'u1', 'one too many'), { error: 'limit' })
  assert.deepEqual(addKeyword(db, 'u1', 'x'), { error: 'invalid' })
  removeKeyword(db, 'u1', 'keyword 0')
  assert.equal(listKeywords(db, 'u1').length, 9)
})

test('runIndexChecks: site: query, host match counts subdomains and www, records results and spend', async () => {
  const db = setup()
  saveDomain(db, 'u1', 'acme.com')
  addKeyword(db, 'u1', 'crm for small teams')
  addKeyword(db, 'u1', 'sales tool')
  const queries: string[] = []
  const f = (async (u: string) => { queries.push(String(u)); return hits([`https://blog.acme.com/post`])(u) }) as unknown as typeof fetch
  const out = await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW })
  assert.ok(out)
  assert.equal(out!.length, 2)
  assert.ok(queries.every(q => decodeURIComponent(q).includes('site:acme.com')))
  assert.ok(out!.every(c => c.indexed && c.top_url === 'https://blog.acme.com/post')) // subdomain counts
  assert.equal(weeklySpend(db, 'u1', NOW), 2)
  assert.equal(latestResults(db, 'u1').length, 2)
  assert.ok((getConfig(db, 'u1')?.next_run_at ?? 0) > NOW)
})

test('runIndexChecks: no own-domain hit means not found; foreign hosts never count', async () => {
  const db = setup()
  saveDomain(db, 'u1', 'acme.com')
  addKeyword(db, 'u1', 'crm')
  const f = hits(['https://acme.com.evil.example/x', 'https://notacme.com/y'])
  const out = await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW })
  assert.deepEqual(out, [{ keyword: 'crm', indexed: false, top_url: null }])
})

test('weekly allowance: 10 per rolling week, then nothing runs', async () => {
  const db = setup()
  saveDomain(db, 'u1', 'acme.com')
  for (let i = 0; i < 10; i++) addKeyword(db, 'u1', `k${i}`)
  const f = hits([`https://acme.com/p`])
  const out = await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW })
  assert.equal(out!.length, 10) // all 10 keywords in one batch - the raised per-batch cap, not the 4/scan cap
  assert.equal(weeklySpend(db, 'u1', NOW), WEEKLY_ALLOWANCE)
  assert.equal(await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW + 60 }), null) // allowance spent
  assert.equal(await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW + 8 * 24 * 3600 }) !== null, true) // next week works
})

test('dueTenants: never-run and past-due only', async () => {
  const db = setup()
  saveDomain(db, 'u1', 'acme.com')
  addKeyword(db, 'u1', 'kw')
  assert.deepEqual(dueTenants(db, NOW), ['u1'])
  await runIndexChecks(db, 'u1', { env, fetchImpl: hits(['https://acme.com']), now: NOW })
  assert.deepEqual(dueTenants(db, NOW + 60), [])
  assert.deepEqual(dueTenants(db, NOW + 8 * 24 * 3600), ['u1'])
})

test('nothing to run: no config, no keywords, or tinyfish off', async () => {
  const db = setup()
  assert.equal(await runIndexChecks(db, 'u1', { env, now: NOW }), null)
  saveDomain(db, 'u1', 'acme.com')
  assert.equal(await runIndexChecks(db, 'u1', { env, now: NOW }), null) // no keywords
  addKeyword(db, 'u1', 'kw')
  assert.equal(await runIndexChecks(db, 'u1', { env: {}, now: NOW }), null) // no operator key
})
