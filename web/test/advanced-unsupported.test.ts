// #436: an adapter the session worker cannot read (Facebook, XiaoHongShu) is reported as unsupported, never as a search
// that found nothing; auth failure, throttling, a malformed answer and an upstream failure each keep their own outcome.
// Worker -> app audit -> Settings and the scan's source list. Synthetic only: platform requests are stubbed, no session
// is collected for an unsupported adapter, nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { migrateConnectors, saveCredential, recentAudit } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent, collectAdvanced, httpWorker, workerAuditStatus, type WorkerFetch } from '../lib/advanced/index.ts'
import { platformSupported } from '../lib/advanced/config.ts'
import { socialSources } from '../lib/scan/source-availability.ts'
import { CHANNELS } from '../lib/channels.ts'
import { createWorkerServer } from '../../session-worker/src/server.ts'

const master = randomBytes(32)
const ON: Record<string, string | undefined> = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'http://worker.internal:9000', ADVANCED_WORKER_TOKEN: 't' }
const item = { url: 'https://www.reddit.com/r/x/comments/1/a/', title: 'Acme hires', quote: 'Acme Robotics is hiring its first sales lead', date: '2026-10-10', login_walled: true }
function setup() { const db = new Database(':memory:'); migrateConnectors(db); migrateAdvanced(db); acceptConsent(db, 'A', 'advanced'); return db }
const audits = (db: Database.Database) => (recentAudit(db, 'A', 50) as { connector: string; status: string; results: number }[]).reverse().map(a => [a.connector, a.status, a.results])

test('unsupported adapters: never searched, no session sent, audited as unsupported (not empty), not counted as a call', async () => {
  const db = setup(); const calls: unknown[] = []
  saveCredential(db, 'A', 'adv:facebook', 'c_user=1; xs=a-session-saved-before', master)
  const worker: WorkerFetch = async r => { calls.push(r); return [] }
  const out = await collectAdvanced(db, 'A', 'j1', ['facebook', 'xiaohongshu'], 'dental practices hiring', { worker, master, env: ON })
  assert.deepEqual([out, calls], [[], []])
  assert.deepEqual(audits(db), [['adv:facebook', 'unsupported', 0], ['adv:xiaohongshu', 'unsupported', 0]])
  assert.deepEqual(['facebook', 'xiaohongshu', 'reddit', 'x'].map(p => platformSupported(p as never)), [false, false, true, true])
  // unsupported rows are not calls: the hourly limit for a supported platform is untouched
  for (let i = 0; i < 12; i++) await collectAdvanced(db, 'A', 'j1', ['facebook'], 'q', { worker, master, env: ON })
  await collectAdvanced(db, 'A', 'j1', ['reddit'], 'q', { worker: async () => [item], master, env: ON })
  assert.deepEqual(audits(db).at(-1), ['adv:reddit', 'ok', 1])
})

test('each worker outcome keeps its own audit status; only a search that ran and found nothing is empty', async () => {
  const cases: [Awaited<ReturnType<WorkerFetch>>, string][] = [
    [[], 'empty'], [[item], 'ok'], [null, 'worker_error'],
    [{ failure: 'auth' }, 'auth_failed'], [{ failure: 'throttled' }, 'throttled'], [{ failure: 'schema' }, 'schema_error'],
    [{ failure: 'upstream' }, 'worker_error'], [{ failure: 'timeout' }, 'worker_error'], [{ failure: 'error' }, 'worker_error'], [{ failure: 'unsupported' }, 'unsupported'],
  ]
  for (const [answer, status] of cases) {
    const db = setup()
    await collectAdvanced(db, 'A', 'j1', ['reddit'], 'q', { worker: async () => answer, master, env: ON })
    assert.equal(audits(db)[0][1], status, JSON.stringify(answer))
    if (!Array.isArray(answer)) assert.equal(workerAuditStatus(answer), status)
  }
  // auth failures, throttling and schema errors were real calls: they count toward the hourly limit (10)
  const db = setup()
  for (let i = 0; i < 10; i++) await collectAdvanced(db, 'A', 'j1', ['reddit'], 'q', { worker: async () => ({ failure: (['auth', 'throttled', 'schema'] as const)[i % 3] }), master, env: ON })
  await collectAdvanced(db, 'A', 'j1', ['reddit'], 'q', { worker: async () => [item], master, env: ON })
  assert.equal(audits(db).at(-1)![1], 'rate_limited')
})

test('httpWorker reads the protocol: 501 unsupported, an outcome, a genuine empty list; anything else is not a result', async () => {
  const w = (status: number, body: string) => httpWorker(ON, (async () => new Response(body, { status })) as typeof fetch)({ platform: 'reddit', query: 'q', session: '' })
  assert.deepEqual(await w(501, '{"items":[],"outcome":"unsupported"}'), { failure: 'unsupported' })
  assert.deepEqual(await w(200, '{"items":[],"outcome":"throttled"}'), { failure: 'throttled' })
  assert.deepEqual(await w(200, '{"items":[],"outcome":"auth"}'), { failure: 'auth' })
  assert.equal(await w(200, '{"items":[],"outcome":"something-new"}'), null)
  assert.deepEqual(await w(200, '{"items":[]}'), [])
  assert.equal(await w(500, '{}'), null)
  assert.equal(await w(200, 'not json'), null)
})

test('end to end: the real worker server, the app over HTTP, the audit rows', async () => {
  const realFetch = globalThis.fetch
  let platform: (u: string) => Response = () => { throw new Error('unexpected') }
  const platformCalls: string[] = []
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const url = String(u)
    if (url.startsWith('http://127.0.0.1')) return realFetch(url, init)
    platformCalls.push(url); return platform(url)
  }) as typeof fetch
  const server = createWorkerServer('t')
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const env = { ...ON, ADVANCED_WORKER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
    // the worker itself answers 501 for an unsupported adapter, with no platform request
    assert.deepEqual(await httpWorker(env)({ platform: 'facebook', query: 'q', session: 'c_user=1' }), { failure: 'unsupported' })
    const db = setup()
    saveCredential(db, 'A', 'adv:reddit', 'reddit_session=abc123', master)
    for (const [resp, status] of [
      [() => new Response('{}', { status: 401 }), 'auth_failed'], [() => new Response('{}', { status: 429 }), 'throttled'],
      [() => new Response('<html></html>', { status: 200 }), 'schema_error'], [() => new Response('{"data":{"children":[]}}', { status: 200 }), 'empty'],
    ] as const) {
      platform = resp
      await collectAdvanced(db, 'A', 'j1', ['reddit'], 'dental practices hiring', { master, env })
      assert.equal(audits(db).at(-1)![1], status)
    }
    await collectAdvanced(db, 'A', 'j1', ['facebook'], 'dental practices hiring', { master, env })
    assert.deepEqual(audits(db).at(-1), ['adv:facebook', 'unsupported', 0])
    assert.ok(platformCalls.every(u => u.startsWith('https://www.reddit.com/')), 'only the stubbed reddit endpoint was addressed')
  } finally { server.close(); globalThis.fetch = realFetch }
})

test('the scan source list and the channel list say "not available", never offer a setup step', () => {
  const rows = socialSources({ available: true, platforms: [
    { platform: 'facebook', allowed: true, supported: false, consent: true, connected: true, enabled: true },
    { platform: 'xiaohongshu', allowed: true, supported: false, consent: false, connected: false, enabled: false },
    { platform: 'reddit', allowed: true, supported: true, consent: true, connected: true, enabled: true },
  ] })
  assert.deepEqual(rows, [
    { id: 'social:facebook', label: 'Facebook', usable: false, reason: 'not available yet' },
    { id: 'social:xiaohongshu', label: 'Xiaohongshu', usable: false, reason: 'not available yet' },
    { id: 'social:reddit', label: 'Reddit', usable: true },
  ])
  assert.deepEqual(CHANNELS.filter(c => c.platform === 'facebook' || c.platform === 'xiaohongshu').map(c => c.status), ['unsupported', 'unsupported'])
})

// The real Settings route in its own process (DB_PATH and the module loader).
test('Settings route: supported flag, no consent or session for an unsupported adapter, removal still works', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs',
    '--test', './test/helpers/advanced-unsupported-runtime.mts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1\b/)
})
