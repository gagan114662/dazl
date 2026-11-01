// The worker's HTTP contract for capability: an unsupported platform is refused before any fetch
// with an explicit outcome; unknown platforms and bad auth are still rejected. No live platform
// requests: only the short-circuited platforms are exercised.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'

const TOKEN = 'test-token-123'
let child: ChildProcess
let base: string

test.before(async () => {
  const port = 4200 + Math.floor(Math.random() * 500)
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    env: { PATH: process.env.PATH, ADVANCED_WORKER_TOKEN: TOKEN, PORT: String(port) },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('worker did not start')
})
test.after(() => { child.kill() })

const post = (body: unknown, auth = true) => fetch(`${base}/fetch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
  body: JSON.stringify(body),
})

test('facebook: refused as unsupported with a reason, never fetched', async () => {
  const r = await post({ platform: 'facebook', query: 'hiring sales', session: 's'.repeat(20) })
  assert.equal(r.status, 200)
  const j = await r.json() as { items: unknown[]; outcome?: string; reason?: string }
  assert.deepEqual(j.items, [])
  assert.equal(j.outcome, 'unsupported')
  assert.match(j.reason ?? '', /browser worker/)
})

test('xiaohongshu: refused as unsupported with a reason', async () => {
  const r = await post({ platform: 'xiaohongshu', query: 'hiring sales', session: 's'.repeat(20) })
  const j = await r.json() as { outcome?: string; reason?: string }
  assert.equal(j.outcome, 'unsupported')
  assert.match(j.reason ?? '', /signing is not implemented/)
})

test('unknown platform, bad auth and bad json are still rejected', async () => {
  assert.equal((await post({ platform: 'myspace', query: 'q', session: 's'.repeat(20) })).status, 400)
  assert.equal((await post({ platform: 'facebook', query: 'q', session: 's'.repeat(20) }, false)).status, 401)
  const bad = await fetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: 'not json' })
  assert.equal(bad.status, 400)
})
