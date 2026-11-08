// #933: a valid-JSON body of the wrong top-level type (null, array, string, number, boolean) must be a bounded 400,
// never a crash of the shared worker. Booted worker with a stubbed platform; after every invalid request /health and a
// further authorized request must still work. No live platform requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { reap } from './boot-util.ts'

const TOKEN = 'test-token-933'
let child: ChildProcess | undefined
let base: string
let exited: number | null = null

const redditListing = { kind: 'Listing', data: { after: null, children: [{ data: { permalink: '/r/sales/comments/1/x/', title: 'Hiring', selftext: 'We are hiring a sales operations manager to clean up our CRM pipeline this quarter.', created_utc: 1761955200 } }] } }
const STUB_BODY = JSON.stringify(redditListing)

// Boot like envelope.test.ts does: an OS-assigned free port (never a random one another suite can hold), a generous
// startup budget that ends EARLY when the child dies, and one retry on a fresh port for the port-race class. The
// child's stderr is kept as a bounded tail (env values scrubbed) so a boot failure carries its own evidence: the
// hosted #933 run failed all 12 cases in this hook with stdio:'ignore' and there was nothing to diagnose.
const freePort = () => new Promise<number>((resolve, reject) => { const srv = createServer(); srv.once('error', reject); srv.listen(0, '127.0.0.1', () => { const a = srv.address(); srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0)) }) })
const scrub = (s: string) => s.split(TOKEN).join('<token>').split(STUB_BODY).join('<stub-body>')
test.before(async () => {
  const diags: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = await freePort()
    let errTail = ''
    const c = spawn(process.execPath, ['--experimental-strip-types', '--import', './test/platform-stub.ts', 'src/server.ts'], {
      env: { PATH: process.env.PATH, ADVANCED_WORKER_TOKEN: TOKEN, PORT: String(port), PLATFORM_STUB_BODY: STUB_BODY },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    c.stderr!.on('data', d => { errTail = (errTail + String(d)).slice(-8192) })
    let gone: number | null = null
    let spawnError: string | null = null
    c.once('error', e => { spawnError = String(e) }) // a failed spawn/kill must not throw an unhandled 'error' event
    c.once('exit', code => { gone = code ?? -1 })
    let up = false
    // A deadline, not a fetch count: each health probe is itself bounded (2s), so a server that accepts but never
    // responds cannot hang the loop past the budget.
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && gone === null && spawnError === null) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) }); if (r.ok) { up = true; break } } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 100))
    }
    if (up) { child = c; base = `http://127.0.0.1:${port}`; child.on('error', () => {}); child.on('exit', code => { exited = code ?? -1 }); return }
    // A real crash must NOT be retried away: its evidence is in the tail, and a deterministic crash just fails
    // again. The retry exists only for the alive-but-never-served startup/port race.
    diags.push(`attempt ${attempt}: port ${port}, exited ${gone}, spawn error: ${spawnError ?? 'none'}, stderr tail: ${scrub(errTail.trim()) || '<empty>'}`)
    const crashed = gone !== null || spawnError !== null // snapshot BEFORE reap: reaping fires the exit listener
    let reaped = true
    try { await reap(c) } catch (e) { reaped = false; diags.push(`reap: ${String(e)}`) }
    if (crashed || !reaped) break // a child that will not die is not the port-race class - never retry under it
  }
  throw new Error(`worker did not start - ${diags.join(' | ')}`)
})
test.after(async () => { if (child) await reap(child) }) // child may be unset when before() failed

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
