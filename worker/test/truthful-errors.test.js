import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerServer } from '../server.js'

// #436: the deployed worker must answer the app's typed-failure contract (web/lib/advanced/index.ts):
// a supported platform whose fetch FAILED is a non-200 with a known failure outcome - never 200 {items:[]},
// which the app would audit as a genuine zero-result search. An unknown platform is an explicit
// 'unsupported' outcome, also never a zero-result search.

const TOKEN = 'test-token-0123456789abcdef'
const ITEM = { url: 'https://www.reddit.com/r/startups/comments/abc/we_just_raised/', title: 'We just raised $2M and are hiring', quote: 'Excited to announce our seed round today.', date: '2026-10-20', login_walled: false }

const withWorker = async (handlers, fn) => {
  const server = createWorkerServer(handlers, TOKEN)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body, auth = `Bearer ${TOKEN}`) => fetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) })
  try { await fn({ post, base }) } finally { server.close() }
}

test('a failing supported platform answers its typed failure, never an empty result', async () => {
  const cases = [
    ['reddit 401', 502, 'auth_failed'],
    ['reddit 403', 502, 'auth_failed'],
    ['x session needs auth_token and ct0 cookies', 502, 'auth_failed'],
    ['x 429', 429, 'throttled'],
    ['reddit 429 too many requests', 429, 'throttled'],
    ['reddit schema: listing envelope missing children array', 502, 'schema_error'],
    ['x schema: adaptive.json envelope missing globalObjects.tweets', 502, 'schema_error'],
    ['reddit 500', 502, 'upstream_error'],
    ['fetch failed: ETIMEDOUT', 502, 'upstream_error'],
  ]
  for (const [message, code, outcome] of cases) {
    await withWorker({ reddit: async () => { throw new Error(message) } }, async ({ post }) => {
      const res = await post({ platform: 'reddit', query: 'hiring founders', session: 's'.repeat(20) })
      assert.equal(res.status, code, message)
      assert.deepEqual(await res.json(), { outcome }, message)
    })
  }
})

test('an unknown platform is an explicit unsupported outcome, not an empty search', async () => {
  await withWorker({ reddit: async () => [ITEM] }, async ({ post }) => {
    const res = await post({ platform: 'linkedin', query: 'hiring founders', session: 's'.repeat(20) })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.outcome, 'unsupported')
    assert.equal(typeof body.reason, 'string')
    assert.deepEqual(body.items, [])
  })
})

test('a successful search and a genuine zero-result search keep their 200 shapes', async () => {
  await withWorker({ reddit: async () => [ITEM] }, async ({ post }) => {
    const res = await post({ platform: 'reddit', query: 'hiring founders', session: 's'.repeat(20) })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].url, ITEM.url)
    assert.equal(body.outcome, undefined, 'a list answer carries no outcome field')
  })
  await withWorker({ reddit: async () => [] }, async ({ post }) => {
    const res = await post({ platform: 'reddit', query: 'hiring founders', session: 's'.repeat(20) })
    assert.deepEqual(await res.json(), { items: [] }, 'a genuine empty search is the only empty 200')
  })
})

test('auth, body and session guards are unchanged', async () => {
  await withWorker({ reddit: async () => [ITEM] }, async ({ post }) => {
    assert.equal((await post({ platform: 'reddit', query: 'hiring founders', session: 's'.repeat(20) }, 'Bearer wrong')).status, 401)
    assert.equal((await post({ platform: 'reddit' })).status, 400)
    assert.equal((await post({ platform: 'reddit', query: 'hiring founders' })).status, 400) // no tenant session, no operator session
  })
})
