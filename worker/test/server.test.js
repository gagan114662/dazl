import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const PORT = 18931
const TOKEN = 'test-token-0123456789abcdef'

const withServer = async (fn) => {
  const proc = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT), ADVANCED_WORKER_TOKEN: TOKEN }, stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 600))
  try { await fn() } finally { proc.kill() }
}

test('health is open; fetch needs the bearer token; bad bodies are 400s; unknown platforms return empty', async () => {
  await withServer(async () => {
    const health = await fetch(`http://127.0.0.1:${PORT}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual((await health.json()).platforms.sort(), ['linkedin', 'reddit', 'x'])

    const noAuth = await fetch(`http://127.0.0.1:${PORT}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(noAuth.status, 401)

    const bad = await fetch(`http://127.0.0.1:${PORT}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{"platform":"reddit"}' })
    assert.equal(bad.status, 400)

    const unknown = await fetch(`http://127.0.0.1:${PORT}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ platform: 'instagram', query: 'hiring founders', session: 'a'.repeat(20) }) })
    assert.equal(unknown.status, 200)
    assert.deepEqual(await unknown.json(), { items: [] })
  })
})
