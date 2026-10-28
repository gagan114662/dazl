// SEO indexing checks (lib/seo/indexing.ts) on both stores: config and keywords, the weekly allowance, due tenants,
// two tenants kept apart, and on Postgres the 10-keyword cap holding when two instances add at once. TinyFish is a
// local fake (fetchImpl); nothing leaves the process.
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import { saveDomain, getConfig, addKeyword, removeKeyword, listKeywords, runIndexChecks, latestResults, weeklySpend, dueTenants, WEEKLY_ALLOWANCE, MAX_KEYWORDS } from '../lib/seo/indexing.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = 1_800_000_000
const env = { TINYFISH_API_KEY: 'tf-key' }
const hits = (urls: string[]) => (async () => new Response(JSON.stringify({ results: urls.map(u => ({ url: u, title: 't', snippet: 'a long enough snippet for the test', date: '2027-01-01' })) }), { status: 200 })) as unknown as typeof fetch

bothEngines('indexing: config and keywords: save, cap at 10, remove', async ({ db }) => {
  assert.equal(await saveDomain(db, 'u1', 'https://www.acme.com/path'), 'acme.com')
  assert.deepEqual((await getConfig(db, 'u1'))?.domain, 'acme.com')
  for (let i = 0; i < 10; i++) assert.deepEqual(await addKeyword(db, 'u1', `keyword ${i}`), { ok: true })
  assert.deepEqual(await addKeyword(db, 'u1', 'one too many'), { error: 'limit' })
  assert.deepEqual(await addKeyword(db, 'u1', 'x'), { error: 'invalid' })
  await removeKeyword(db, 'u1', 'keyword 0')
  assert.equal((await listKeywords(db, 'u1')).length, 9)
})

bothEngines('indexing: runIndexChecks: site: query, host match counts subdomains and www, records results and spend', async ({ db }) => {
  await resetTinyfishState(db)
  await saveDomain(db, 'u1', 'acme.com')
  await addKeyword(db, 'u1', 'crm for small teams')
  await addKeyword(db, 'u1', 'sales tool')
  const queries: string[] = []
  const f = (async (u: string) => { queries.push(String(u)); return hits(['https://blog.acme.com/post'])(u) }) as unknown as typeof fetch
  const out = await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW })
  assert.equal(out!.length, 2)
  assert.ok(queries.every(q => decodeURIComponent(q).includes('site:acme.com')))
  assert.ok(out!.every(c => c.indexed && c.top_url === 'https://blog.acme.com/post')) // subdomain counts
  assert.equal(await weeklySpend(db, 'u1', NOW), 2)
  assert.equal((await latestResults(db, 'u1')).length, 2)
  assert.ok(((await getConfig(db, 'u1'))?.next_run_at ?? 0) > NOW)
})

bothEngines('indexing: no own-domain hit means not found; foreign hosts never count', async ({ db }) => {
  await resetTinyfishState(db)
  await saveDomain(db, 'u1', 'acme.com')
  await addKeyword(db, 'u1', 'crm')
  const out = await runIndexChecks(db, 'u1', { env, fetchImpl: hits(['https://acme.com.evil.example/x', 'https://notacme.com/y']), now: NOW })
  assert.deepEqual(out, [{ keyword: 'crm', indexed: false, top_url: null }])
})

bothEngines('indexing: weekly allowance: 10 per rolling week, then nothing runs', async ({ db }) => {
  await resetTinyfishState(db)
  await saveDomain(db, 'u1', 'acme.com')
  for (let i = 0; i < 10; i++) await addKeyword(db, 'u1', `k${i}`)
  const f = hits(['https://acme.com/p'])
  const out = await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW })
  assert.equal(out!.length, 10) // all 10 keywords in one batch - the raised per-batch cap, not the 4/scan cap
  assert.equal(await weeklySpend(db, 'u1', NOW), WEEKLY_ALLOWANCE)
  assert.equal(await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW + 60 }), null) // allowance spent
  await resetTinyfishState(db)
  assert.notEqual(await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW + 8 * 24 * 3600 }), null) // next week works
})

bothEngines('indexing: dueTenants: never-run and past-due only; nothing to run without config, keywords or TinyFish', async ({ db }) => {
  await resetTinyfishState(db)
  assert.equal(await runIndexChecks(db, 'u1', { env, now: NOW }), null)
  await saveDomain(db, 'u1', 'acme.com')
  assert.equal(await runIndexChecks(db, 'u1', { env, now: NOW }), null) // no keywords
  await addKeyword(db, 'u1', 'kw')
  assert.equal(await runIndexChecks(db, 'u1', { env: {}, now: NOW }), null) // no operator key
  assert.deepEqual(await dueTenants(db, NOW), ['u1'])
  await runIndexChecks(db, 'u1', { env, fetchImpl: hits(['https://acme.com']), now: NOW })
  assert.deepEqual(await dueTenants(db, NOW + 60), [])
  assert.deepEqual(await dueTenants(db, NOW + 8 * 24 * 3600), ['u1'])
})

bothEngines('indexing: two tenants: each reads, changes and spends only its own', async ({ db }) => {
  await resetTinyfishState(db)
  await saveDomain(db, 'A', 'alpha.example'); await saveDomain(db, 'B', 'bravo.example')
  await addKeyword(db, 'A', 'alpha secret'); await addKeyword(db, 'B', 'bravo secret')
  await runIndexChecks(db, 'A', { env, fetchImpl: hits(['https://alpha.example/x']), now: NOW })
  // B removing A's keyword by name removes nothing of A's
  await removeKeyword(db, 'B', 'alpha secret')
  assert.deepEqual(await listKeywords(db, 'A'), ['alpha secret'])
  assert.deepEqual(await listKeywords(db, 'B'), ['bravo secret'])
  assert.deepEqual(await latestResults(db, 'B'), [])
  assert.deepEqual([await weeklySpend(db, 'A', NOW), await weeklySpend(db, 'B', NOW)], [1, 0])
  assert.equal((await getConfig(db, 'B'))?.domain, 'bravo.example')
  // B's keyword cap is its own: A's keywords do not count against it
  for (let i = 0; i < MAX_KEYWORDS - 1; i++) assert.deepEqual(await addKeyword(db, 'B', `b${i}`), { ok: true })
  assert.deepEqual(await addKeyword(db, 'B', 'b-over'), { error: 'limit' })
})

bothEngines('indexing: two instances adding keywords at once never pass the cap of 10', async ({ db, kind, url, schema }) => {
  if (kind !== 'pg') return // SQLite runs one write transaction at a time; the race is between Postgres connections
  const pools = Array.from({ length: 6 }, () => pgDb({ connectionString: url!, searchPath: schema, max: 1 }))
  try {
    for (let i = 0; i < 7; i++) await addKeyword(db, 'u1', `seed ${i}`)
    const rs = await Promise.all(pools.map((p, i) => addKeyword(p, 'u1', `racing ${i}`)))
    assert.equal(rs.filter(r => 'ok' in r).length, 3, JSON.stringify(rs))
    assert.equal((await listKeywords(db, 'u1')).length, MAX_KEYWORDS)
  } finally { await Promise.all(pools.map(p => p.close())) }
})
