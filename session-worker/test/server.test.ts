// The worker's HTTP contract (#436): an adapter it cannot read answers 501 unsupported without any request, and every
// way a search can fail is reported as an outcome, never as an empty successful search. Platform requests are stubbed:
// nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createWorkerServer } from '../src/server.ts'

const realFetch = globalThis.fetch
const platformCalls: string[] = []
let platform: (url: string) => Response = () => { throw new Error('unexpected platform request') }
globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
  const url = String(u)
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, init)
  platformCalls.push(url); return platform(url)
}) as typeof fetch

const server = createWorkerServer('test-token')
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const call = async (body: unknown) => {
  const r = await realFetch(`${base}/fetch`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json() as Record<string, unknown> }
}
test.after(() => server.close())

test('facebook and xiaohongshu: 501 unsupported, no platform request, whatever the session', async () => {
  for (const p of ['facebook', 'xiaohongshu']) for (const session of ['c_user=1; xs=2', ''])
    assert.deepEqual(await call({ platform: p, query: 'dental practices hiring', session }), { status: 501, json: { items: [], outcome: 'unsupported' } }, `${p} ${session}`)
  assert.deepEqual(platformCalls, [])
})

test('every failure is an outcome, never an empty success; a genuine empty search has no outcome', async () => {
  const reddit = (resp: () => Response) => { platform = resp; return call({ platform: 'reddit', query: 'q', session: 'reddit_session=abc' }) }
  assert.deepEqual((await reddit(() => new Response('{}', { status: 401 }))).json, { items: [], outcome: 'auth' })
  assert.deepEqual((await reddit(() => new Response('{}', { status: 403 }))).json, { items: [], outcome: 'auth' })
  assert.deepEqual((await reddit(() => new Response('{}', { status: 429 }))).json, { items: [], outcome: 'throttled' })
  assert.deepEqual((await reddit(() => new Response('{}', { status: 503 }))).json, { items: [], outcome: 'upstream' })
  assert.deepEqual((await reddit(() => new Response('<html>login</html>', { status: 200 }))).json, { items: [], outcome: 'schema' })
  assert.deepEqual((await reddit(() => new Response('{"unexpected":true}', { status: 200 }))).json, { items: [], outcome: 'schema' })
  assert.deepEqual((await reddit(() => { throw new TypeError('fetch failed') })).json, { items: [], outcome: 'upstream' })
  // a search that ran and found nothing: items [] and no outcome
  assert.deepEqual(await reddit(() => new Response('{"data":{"children":[]}}', { status: 200 })), { status: 200, json: { items: [] } })
  // a session missing what the platform needs: auth, with no request
  const before = platformCalls.length
  assert.deepEqual((await call({ platform: 'x', query: 'q', session: 'not-an-x-cookie' })).json, { items: [], outcome: 'auth' })
  assert.deepEqual((await call({ platform: 'linkedin', query: 'q', session: 'no-li-at-here' })).json, { items: [], outcome: 'auth' })
  assert.equal(platformCalls.length, before)
  // Bilibili refuses with a code inside a 200
  platform = () => new Response('{"code":-101}', { status: 200 })
  assert.deepEqual((await call({ platform: 'bilibili', query: 'q', session: 'SESSDATA=x' })).json, { items: [], outcome: 'auth' })
  platform = () => new Response('{"code":-412}', { status: 200 })
  assert.deepEqual((await call({ platform: 'bilibili', query: 'q', session: 'SESSDATA=x' })).json, { items: [], outcome: 'throttled' })
})
