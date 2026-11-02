// #436: a failed platform request is a typed failure, never an empty result. Stubbed fetch only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FetchFailure, getJson } from '../src/util.ts'
import { FETCHERS } from '../src/fetchers.ts'

const realFetch = globalThis.fetch
const stub = (status: number, body: string) => { globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch }
test.afterEach(() => { globalThis.fetch = realFetch })
const kind = async (p: Promise<unknown>) => { try { await p; return 'resolved' } catch (e) { return e instanceof FetchFailure ? e.kind : 'other' } }

test('getJson: status and body map to auth, throttling, schema and upstream failures', async () => {
  for (const [status, body, want] of [[401, '{}', 'auth_failed'], [403, '{}', 'auth_failed'], [429, '{}', 'throttled'], [500, '{}', 'upstream_error'], [200, '<html>login</html>', 'schema_error']] as const) {
    stub(status, body)
    assert.equal(await kind(getJson('https://example.test/x')), want, `${status}`)
  }
  stub(200, '{"ok":1}')
  assert.deepEqual(await getJson('https://example.test/x'), { ok: 1 })
})

test('fetchers: a throttled or rejected platform call rejects instead of returning []', async () => {
  stub(429, '{}')
  assert.equal(await kind(FETCHERS.reddit('q', 'cookie=1', {})), 'throttled')
  stub(401, '{}')
  assert.equal(await kind(FETCHERS.bilibili('q', 'SESSDATA=1', {})), 'auth_failed')
  assert.equal(await kind(FETCHERS.x('q', 'no-cookies', {})), 'auth_failed')
  assert.equal(await kind(FETCHERS.linkedin('q', 'no-cookies', {})), 'auth_failed')
  stub(200, '{"data":{"children":[]}}')
  assert.deepEqual(await FETCHERS.reddit('q', 'cookie=1', {}), [], 'a genuine empty search still resolves []')
})
