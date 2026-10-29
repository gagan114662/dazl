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

// Running checks pays for TinyFish searches. Every run claims its batch from the weekly allowance before its first
// request, so runs at once (two manual runs, or a manual run and the tick) never send more than 10 searches a week
// between them. A sent search counts even when it failed, and a run that dies keeps its claim spent.
const counting = (urls: string[]) => {
  const sent: string[] = []
  const f = (async (u: string) => { sent.push(String(u)); await new Promise(r => setTimeout(r, 5)); return hits(urls)(u) }) as unknown as typeof fetch
  return { sent, f }
}

bothEngines('indexing: two runs at once never send more than the weekly 10 searches between them', async ({ db, kind, url, schema }) => {
  await resetTinyfishState(db)
  await saveDomain(db, 'u1', 'acme.com')
  for (let i = 0; i < 10; i++) await addKeyword(db, 'u1', `keyword ${i}`)
  // two workers: on Postgres two pools (two instances); on SQLite two runs interleaving in one process
  const other = kind === 'pg' ? pgDb({ connectionString: url!, searchPath: schema, max: 1 }) : db
  try {
    const { sent, f } = counting(['https://acme.com/p'])
    const [a, b] = await Promise.all([runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW, id: 'runA' }), runIndexChecks(other, 'u1', { env, fetchImpl: f, now: NOW, id: 'runB' })])
    assert.equal(sent.length, 10, `${sent.length} searches sent against an allowance of 10`)
    assert.equal((a?.length ?? 0) + (b?.length ?? 0), 10)
    assert.ok(a === null || b === null || a.length + b.length === 10, 'one run took the batch, the other found nothing left (or they split it)')
    assert.equal(await weeklySpend(db, 'u1', NOW), 10)
    assert.equal(await runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW + 60 }), null, 'spent for the week')
  } finally { if (other !== db) await other.close() }
})

bothEngines('indexing: a manual run and the tick at once (both call runIndexChecks) share the one allowance', async ({ db, kind, url, schema }) => {
  await resetTinyfishState(db)
  await saveDomain(db, 'u1', 'acme.com')
  for (let i = 0; i < 6; i++) await addKeyword(db, 'u1', `keyword ${i}`)
  // 6 searches already spent this week: 4 left for whichever run claims them
  await runIndexChecks(db, 'u1', { env, fetchImpl: counting(['https://acme.com/p']).f, now: NOW - 3600 })
  const tick = kind === 'pg' ? pgDb({ connectionString: url!, searchPath: schema, max: 1 }) : db
  try {
    const { sent, f } = counting(['https://acme.com/p'])
    await Promise.all([runIndexChecks(db, 'u1', { env, fetchImpl: f, now: NOW, id: 'manual' }), runIndexChecks(tick, 'u1', { env, fetchImpl: f, now: NOW, id: 'tick' })])
    assert.equal(sent.length, 4)
    assert.equal(await weeklySpend(db, 'u1', NOW), 10)
  } finally { if (tick !== db) await tick.close() }
})

bothEngines('indexing: a failed search still counts; the batch is claimed before its first request (a crash keeps it spent)', async ({ db }) => {
  await resetTinyfishState(db)
  await saveDomain(db, 'u1', 'acme.com')
  for (let i = 0; i < 3; i++) await addKeyword(db, 'u1', `keyword ${i}`)
  // the first search fails at TinyFish: nothing checked, the batch stops, but that request was sent and counts
  let claimedAtFirstRequest = -1
  const failing = (async () => { claimedAtFirstRequest = await weeklySpend(db, 'u1', NOW); return new Response('upstream', { status: 500 }) }) as unknown as typeof fetch
  assert.deepEqual(await runIndexChecks(db, 'u1', { env, fetchImpl: failing, now: NOW }), [])
  assert.equal(claimedAtFirstRequest, 3, 'all three searches were claimed before the first request went out')
  assert.equal(await weeklySpend(db, 'u1', NOW), 1, 'the failed search counts; the two never sent are given back')
})

bothEngines('indexing: six instances claiming at once, repeatedly, never claim past 10', async ({ db, kind, url, schema }) => {
  if (kind !== 'pg') return // SQLite runs one write transaction at a time; the race is between Postgres connections
  const pools = Array.from({ length: 6 }, () => pgDb({ connectionString: url!, searchPath: schema, max: 1 }))
  try {
    for (let round = 0; round < 8; round++) {
      const t = `t${round}`
      await resetTinyfishState(db)
      await saveDomain(db, t, 'acme.com')
      for (let i = 0; i < 4; i++) await addKeyword(db, t, `keyword ${i}`)
      const { sent, f } = counting(['https://acme.com/p'])
      // six runs of 4 keywords: 24 wanted, 10 allowed
      await Promise.all(pools.map((p, i) => runIndexChecks(p, t, { env: { ...env, TINYFISH_TENANT_DAILY: '1000', TINYFISH_PER_MINUTE: '1000' }, fetchImpl: f, now: NOW, id: `r${round}p${i}` })))
      assert.equal(sent.length, 10, `round ${round}: ${sent.length} searches sent`)
      assert.equal(await weeklySpend(db, t, NOW), 10)
    }
  } finally { await Promise.all(pools.map(p => p.close())) }
})
