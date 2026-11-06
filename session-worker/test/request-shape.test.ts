// #933: a valid-JSON body of the wrong top-level type (null, array, string, number, boolean) must be a bounded 400,
// never a crash of the shared worker. Booted worker with a stubbed platform; after every invalid request /health and a
// further authorized request must still work. No live platform requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'

const TOKEN = 'test-token-933'
let child: ChildProcess
let base: string
let exited: number | null = null

const redditListing = { kind: 'Listing', data: { after: null, children: [{ data: { permalink: '/r/sales/comments/1/x/', title: 'Hiring', selftext: 'We are hiring a sales operations manager to clean up our CRM pipeline this quarter.', created_utc: 1761955200 } }] } }

test.before(async () => {
  const port = 4800 + Math.floor(Math.random() * 500)
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--experimental-strip-types', '--import', './test/platform-stub.ts', 'src/server.ts'], {
    env: { PATH: process.env.PATH, ADVANCED_WORKER_TOKEN: TOKEN, PORT: String(port), PLATFORM_STUB_BODY: JSON.stringify(redditListing) },
    stdio: 'ignore',
  })
  child.on('exit', code => { exited = code ?? -1 })
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('worker did not start')
})
test.after(() => { child.kill() })

const raw = (body: string) => fetch(`${base}/fetch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body,
})
const unsupported = { platform: 'facebook', query: 'hiring sales', session: 's'.repeat(20) }
const supported = { platform: 'reddit', query: 'hiring sales', session: 'reddit_session=1' }

async function stillAlive() {
  assert.equal(exited, null, 'worker process exited')
  assert.equal((await fetch(`${base}/health`)).status, 200)
  const r = await raw(JSON.stringify(unsupported))
  assert.equal(r.status, 200)
  assert.equal(((await r.json()) as { outcome?: string }).outcome, 'unsupported')
}

for (const [name, body] of [
  ['null', 'null'], ['array', '[]'], ['array of a request', JSON.stringify([supported])], ['string', '"reddit"'],
  ['number', '42'], ['boolean true', 'true'], ['boolean false', 'false'], ['malformed syntax', '{"platform":'],
] as const) {
  test(`${name} body: bounded 400 and the worker keeps serving`, async () => {
    const r = await raw(body)
    assert.equal(r.status, 400)
    assert.ok(typeof ((await r.json()) as { error?: unknown }).error === 'string')
    await stillAlive()
  })
}

test('non-string query or session on a supported platform is a 400, not a fetch', async () => {
  for (const bad of [{ ...supported, query: 7 }, { ...supported, session: ['x'] }, { ...supported, query: null }]) {
    assert.equal((await raw(JSON.stringify(bad))).status, 400)
  }
  await stillAlive()
})

test('valid unsupported request keeps its contract', async () => {
  const r = await raw(JSON.stringify(unsupported))
  assert.equal(r.status, 200)
  const j = await r.json() as { items: unknown[]; outcome?: string; reason?: string }
  assert.deepEqual(j.items, [])
  assert.equal(j.outcome, 'unsupported')
})

test('valid supported request returns the stubbed items', async () => {
  const r = await raw(JSON.stringify(supported))
  assert.equal(r.status, 200)
  const j = await r.json() as { items: unknown[] }
  assert.equal(j.items.length, 1)
  await stillAlive()
})

test('auth is still checked before the body is read', async () => {
  const r = await fetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })
  assert.equal(r.status, 401)
  await stillAlive()
})
