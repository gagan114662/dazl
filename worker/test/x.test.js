import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchX } from '../lib/x.js'

const SESSION = 'auth_token=abc123; ct0=def456'
const ADAPTIVE_OK = { globalObjects: { tweets: { '1': { id_str: '1', full_text: 'we just raised a seed round and are hiring engineers for our dev tools startup', created_at: 'Mon Oct 20 12:00:00 +0000 2026', user_id_str: '42' } }, users: { '42': { screen_name: 'acme' } } } }
const EMPTY_TIMELINE = { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } } }
const TWEET = { result: { legacy: { id_str: '7', full_text: 'we just raised a seed round and are hiring engineers for our dev tools startup', created_at: 'Mon Oct 20 12:00:00 +0000 2026' }, core: { user_results: { result: { core: { screen_name: 'acme' } } } } } }
const TIMELINE_OK = { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: TWEET } } }] }] } } } } }

const withFetch = async (impl, fn) => {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  try { await fn() } finally { globalThis.fetch = orig }
}

test('fetchX falls back to adaptive.json when SearchTimeline returns 0 items', async () => {
  const urls = []
  await withFetch(async (url) => {
    urls.push(String(url))
    if (String(url).includes('adaptive.json')) return new Response(JSON.stringify(ADAPTIVE_OK), { status: 200 })
    return new Response(JSON.stringify(EMPTY_TIMELINE), { status: 200 })
  }, async () => {
    const items = await fetchX({ query: 'hiring founding engineer', session: SESSION })
    assert.equal(items.length, 1)
    assert.equal(items[0].url, 'https://x.com/acme/status/1')
  })
  assert.equal(urls.length, 2)
  assert.ok(urls[0].includes('SearchTimeline'))
  assert.ok(urls[1].includes('adaptive.json'))
})

test('fetchX falls back to adaptive.json when SearchTimeline errors; adaptive failure throws', async () => {
  await withFetch(async (url) => {
    if (String(url).includes('adaptive.json')) return new Response(JSON.stringify(ADAPTIVE_OK), { status: 200 })
    return new Response('nope', { status: 403 })
  }, async () => {
    const items = await fetchX({ query: 'q', session: SESSION })
    assert.equal(items.length, 1)
  })
  await withFetch(async () => new Response('nope', { status: 403 }), async () => {
    await assert.rejects(() => fetchX({ query: 'q', session: SESSION }))
  })
})

test('fetchX returns SearchTimeline results without calling adaptive', async () => {
  let calls = 0
  await withFetch(async () => { calls++; return new Response(JSON.stringify(TIMELINE_OK), { status: 200 }) }, async () => {
    const items = await fetchX({ query: 'q', session: SESSION })
    assert.equal(items.length, 1)
    assert.equal(items[0].url, 'https://x.com/acme/status/7')
  })
  assert.equal(calls, 1)
})

test('fetchX rejects a session missing auth_token/ct0', async () => {
  await assert.rejects(() => fetchX({ query: 'q', session: 'foo=bar' }))
})

test('fetchX sends the live-bundle query id and the fieldToggles variable X now requires', async () => {
  const urls = []
  await withFetch(async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify(TIMELINE_OK), { status: 200 })
  }, async () => {
    delete process.env.X_QUERY_ID
    const items = await fetchX({ query: 'hiring founding engineer', session: SESSION })
    assert.equal(items.length, 1)
  })
  assert.equal(urls.length, 1) // SearchTimeline succeeds, no fallback
  assert.ok(urls[0].includes('/graphql/BYppgupFFS2yqVmmRNjlsw/SearchTimeline'))
  const variables = JSON.parse(decodeURIComponent(new URL(urls[0]).searchParams.get('variables')))
  assert.deepEqual(variables.fieldToggles, [])
  assert.equal(variables.rawQuery, 'hiring founding engineer')
  assert.equal(variables.product, 'Latest')
})

test('fetchX: X_QUERY_ID env override still wins over the shipped default', async () => {
  const urls = []
  await withFetch(async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify(TIMELINE_OK), { status: 200 })
  }, async () => {
    process.env.X_QUERY_ID = 'OverrideId123'
    try { await fetchX({ query: 'q', session: SESSION }) } finally { delete process.env.X_QUERY_ID }
  })
  assert.ok(urls[0].includes('/graphql/OverrideId123/SearchTimeline'))
})
