import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { migrateConnectors, saveCredential, recentAudit } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent, collectAdvanced, httpWorker, type WorkerFetch } from '../lib/advanced/index.ts'
import { UNSUPPORTED_ADAPTERS, adapterSupported, UNSUPPORTED_STATUS } from '../lib/advanced/capability.ts'
import { CHANNELS } from '../lib/channels.ts'

const master = randomBytes(32)
const ON: Record<string, string | undefined> = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'http://worker.internal:9000', ADVANCED_WORKER_TOKEN: 't' }
const item = { url: 'https://x.example/p/1', title: 'Acme hires', quote: 'Acme Robotics is hiring its first sales lead', date: '2026-10-10', login_walled: true }
function setup() { const db = new Database(':memory:'); migrateConnectors(db); migrateAdvanced(db); return db }

test('unsupported adapters are reported as such: no worker call, no session read, an audit row, and supported platforms still run', async () => {
  const db = setup(); acceptConsent(db, 'A', 'advanced')
  // A session saved before this change must not be touched either.
  saveCredential(db, 'A', 'adv:facebook', 'old-facebook-session-1234', master)
  const seen: string[] = []
  const worker: WorkerFetch = async r => { seen.push(`${r.platform}:${r.session ? 'session' : 'nosession'}`); return [item] }
  const out = await collectAdvanced(db, 'A', 'j1', ['facebook', 'xiaohongshu', 'reddit'], 'q', { worker, master, env: ON })
  assert.deepEqual(seen, ['reddit:nosession'], 'only the supported platform reached the worker; the stored facebook session was never read')
  assert.equal(out.length, 1)
  const audit = recentAudit(db, 'A', 50) as { connector: string; status: string }[]
  for (const c of ['adv:facebook', 'adv:xiaohongshu']) assert.equal(audit.find(a => a.connector === c)?.status, UNSUPPORTED_STATUS, c)
})

test('unsupported does not need consent or flags to be reported, and never counts toward the rate limit', async () => {
  const db = setup()   // no consent, no flags
  const worker: WorkerFetch = async () => { throw new Error('must not be called') }
  for (let i = 0; i < 30; i++) await collectAdvanced(db, 'A', 'j', ['facebook'], 'q', { worker, master, env: {} })
  const audit = recentAudit(db, 'A', 100) as { status: string }[]
  assert.ok(audit.length > 0 && audit.every(a => a.status === UNSUPPORTED_STATUS))
})

test('the worker transport maps an explicit 501 unsupported_capability to the unsupported result; anything else is a worker error', async () => {
  const body = (status: number, b: unknown) => (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch
  const req = { platform: 'facebook' as const, query: 'q', session: 'sess-1234567' }
  assert.equal(await httpWorker(ON, body(501, { error: 'unsupported_capability', capability: 'unsupported', platform: 'facebook' }))(req), UNSUPPORTED_STATUS)
  assert.equal(await httpWorker(ON, body(501, { error: 'something else' }))(req), null)
  assert.equal(await httpWorker(ON, body(500, { error: 'unsupported_capability', capability: 'unsupported' }))(req), null)
  assert.deepEqual(await httpWorker(ON, body(200, { items: [item] }))(req), [{ ...item }])
})

test('the web list and the session worker agree on which adapters cannot run; Settings lists them as not supported with no connect flow', () => {
  const fetchers = readFileSync(new URL('../../session-worker/src/fetchers.ts', import.meta.url), 'utf8')
  const block = /export const UNSUPPORTED[^{]*\{([\s\S]*?)\n\}/.exec(fetchers)![1]
  const inWorker = [...block.matchAll(/^\s*(\w+):/gm)].map(m => m[1]).sort()
  assert.deepEqual(inWorker, Object.keys(UNSUPPORTED_ADAPTERS).sort())
  for (const p of inWorker) {
    const ch = CHANNELS.find(c => c.id === p)!
    assert.equal(ch.status, 'soon'); assert.ok(!ch.platform, 'no connect flow, so no session is collected'); assert.match(ch.note, /Not supported yet/); assert.match(ch.note, /No session is collected/)
  }
  assert.equal(adapterSupported('reddit'), true); assert.equal(adapterSupported('facebook'), false)
})
