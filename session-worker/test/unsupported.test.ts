import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { UNSUPPORTED, FETCHERS } from '../src/fetchers.ts'

// The real server process on a loopback port. An adapter that cannot run answers 501 unsupported_capability BEFORE reading the session.
const dir = fileURLToPath(new URL('..', import.meta.url))
async function withServer(run: (call: (body: unknown, token?: string) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>) {
  const port = 3400 + Math.floor(Math.random() * 400)
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { cwd: dir, env: { PATH: process.env.PATH, PORT: String(port), ADVANCED_WORKER_TOKEN: 'tok' }, stdio: 'ignore' })
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break } catch { await new Promise(r => setTimeout(r, 100)) } }
    await run(async (body, token = 'tok') => { const r = await fetch(`http://127.0.0.1:${port}/fetch`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as Record<string, unknown> } })
  } finally { child.kill() }
}

test('facebook and xiaohongshu answer 501 unsupported_capability, with or without a session, and only for an authorized caller', async () => {
  assert.deepEqual(Object.keys(UNSUPPORTED).sort(), ['facebook', 'xiaohongshu'])
  await withServer(async call => {
    for (const platform of ['facebook', 'xiaohongshu']) {
      for (const extra of [{ session: 'a-session-cookie-value' }, {}]) {
        const r = await call({ platform, query: 'dentists', ...extra })
        assert.equal(r.status, 501); assert.equal(r.body.error, 'unsupported_capability'); assert.equal(r.body.capability, 'unsupported'); assert.equal(r.body.platform, platform)
        assert.deepEqual(r.body.items, undefined, 'no items are returned for an adapter that cannot run')
      }
    }
    assert.equal((await call({ platform: 'facebook', query: 'q', session: 'sess-1234567' }, 'wrong')).status, 401, 'the capability answer is not an unauthenticated probe')
    assert.equal((await call({ platform: 'nope', query: 'q', session: 'sess-1234567' })).status, 400)
    assert.equal((await call({ platform: 'reddit', query: 'q' })).status, 400, 'supported platforms are unchanged')
  })
})

test('an unsupported fetcher never silently returns an empty result', async () => {
  for (const p of Object.keys(UNSUPPORTED) as ('facebook' | 'xiaohongshu')[]) await assert.rejects(FETCHERS[p]('q', 's', {}), /unsupported_capability/)
})
