import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { defaultGet } from '../lib/connectors/sitecrawl.ts'

test('Claude-only public reader never dispatches to the configured renderer; normal scans are unchanged', async t => {
  const env = { CRAWL4AI_URL: 'https://reader.example' }
  const target = 'https://8.8.8.8/team' // numerical public address only for the no-network transport mocks
  const native = t.mock.method(https, 'request', () => { throw new Error('native-reader-fixture') })
  const renderer = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    assert.equal(String(url), 'https://reader.example/crawl')
    return Response.json({ results: [{ html: '<h1>Company team</h1>', status_code: 200 }] })
  })
  await assert.rejects(defaultGet(env, true)(target), /native-reader-fixture/)
  assert.equal(native.mock.callCount(), 1)
  assert.equal(renderer.mock.callCount(), 0)
  assert.equal((await defaultGet(env)(target))?.status, 200)
  assert.equal(native.mock.callCount(), 1)
  assert.equal(renderer.mock.callCount(), 1)
})

test('normal renderer preserves true omission but rejects invalid explicit URL metadata; buyer reads stay native', async t => {
  const env = { CRAWL4AI_URL: 'https://reader.example' }
  const target = 'https://8.8.8.8/team'
  const native = t.mock.method(https, 'request', () => { throw new Error('native-reader-fixture') })
  let result: Record<string, unknown> = {}
  const renderer = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ results: [{ html: '<h1>Company team</h1>', status_code: 200, ...result }] }))
  const get = defaultGet(env)
  for (result of [
    { url: target, redirected_url: 'http://8.8.8.8/team/' },
    { url: target, redirected_url: '' },
    { url: target, redirected_url: 'not a URL' },
    { url: target, redirected_url: 'https://example.test/team/' },
    { url: null },
    { url: 'http://8.8.8.8/team', redirected_url: target },
    { status_code: 302 },
    { status_code: 302, url: target, redirected_url: null },
  ]) assert.equal(await get(target), null, JSON.stringify(result))
  result = { url: target, redirected_url: target + '/' }
  assert.equal((await get(target))?.finalUrl, target + '/')
  result = { url: target, redirected_url: null }
  assert.equal((await get(target))?.finalUrl, target)
  result = { redirected_url: null }
  assert.equal((await get(target))?.finalUrl, target)
  result = {}
  assert.equal((await get(target))?.finalUrl, target)
  const rendererBefore = renderer.mock.callCount()
  await assert.rejects(get(target, { noRedirect: true }), /native-reader-fixture/)
  assert.equal(native.mock.callCount(), 1)
  assert.equal(renderer.mock.callCount(), rendererBefore)
})
