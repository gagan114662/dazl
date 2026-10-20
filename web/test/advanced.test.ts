import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateConnectors, saveCredential, recentAudit } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent, hasConsent, collectAdvanced, parseWorkerItems, type WorkerFetch } from '../lib/advanced/index.ts'
import { advFlags } from '../lib/advanced/config.ts'
import { normalizeSources } from '../lib/sources/index.ts'

const master = randomBytes(32)
const ON = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'http://worker.internal:9000', ADVANCED_WORKER_TOKEN: 't' }
const item = { url: 'https://x.example/p/1', title: 'Acme hires', quote: 'Acme Robotics is hiring its first sales lead', date: '2026-10-10', login_walled: true }
function setup() { const db = new Database(':memory:'); migrateConnectors(db); migrateAdvanced(db); return db }

test('flags: off by default, kill switch wins, linkedin needs its own flag', () => {
  assert.deepEqual(advFlags({}), { enabled: false, linkedin: false })
  assert.deepEqual(advFlags(ON), { enabled: true, linkedin: false })
  assert.equal(advFlags({ ...ON, ADVANCED_LINKEDIN: '1' }).linkedin, true)
  assert.deepEqual(advFlags({ ...ON, ADVANCED_LINKEDIN: '1', ADVANCED_KILL: '1' }), { enabled: false, linkedin: false })
  assert.equal(advFlags({ ADVANCED_CONNECTORS: '1' }).enabled, false)
})

test('selection keeps only known advanced platforms', () => {
  assert.deepEqual(normalizeSources({ advanced: ['reddit', 'nope'] }), { adapters: [], feeds: [], advanced: ['reddit'] })
  assert.equal(normalizeSources({ advanced: ['nope'] }), null)
})

test('gates: no consent, no session, flag off, then success, with audit and per-tenant isolation', async () => {
  const db = setup(); let calls = 0; const seen: unknown[] = []
  const worker: WorkerFetch = async r => { calls++; seen.push(r); return [item] }
  const run = (t: string, env = ON, p: 'reddit' | 'linkedin' = 'reddit') => collectAdvanced(db, t, 'j1', [p], 'q', { worker, master, env })
  assert.equal((await run('A')).length, 0)
  acceptConsent(db, 'A', 'advanced'); assert.equal(hasConsent(db, 'A', 'advanced'), true)
  assert.equal((await run('A')).length, 0) // no session yet
  saveCredential(db, 'A', 'adv:reddit', 'session-of-tenant-A-123', master)
  assert.equal((await run('A', {})).length, 0) // flag off
  assert.equal((await run('B')).length, 0) // other tenant has nothing
  assert.equal(calls, 0)
  const out = await run('A'); assert.equal(out.length, 1); assert.equal(out[0].login_walled, true)
  assert.deepEqual(seen, [{ platform: 'reddit', query: 'q', session: 'session-of-tenant-A-123' }])
  saveCredential(db, 'A', 'adv:linkedin', 'li-session-of-A-1234', master); acceptConsent(db, 'A', 'linkedin')
  assert.equal((await run('A', ON, 'linkedin')).length, 0) // linkedin flag off
  assert.equal((await run('A', { ...ON, ADVANCED_LINKEDIN: '1' }, 'linkedin')).length, 1)
  const st = (recentAudit(db, 'A', 50) as { status: string }[]).map(a => a.status)
  assert.ok(st.includes('no_session') && st.includes('disabled') && st.includes('ok'))
})

test('rate limit: per user per hour, kill switch stops calls', async () => {
  const db = setup(); let calls = 0
  const worker: WorkerFetch = async () => { calls++; return [] }
  acceptConsent(db, 'A', 'advanced'); saveCredential(db, 'A', 'adv:reddit', 'session-of-tenant-A-123', master)
  const env = { ...ON, ADVANCED_MAX_PER_HOUR: '2' }
  for (let i = 0; i < 4; i++) await collectAdvanced(db, 'A', 'j', ['reddit'], 'q', { worker, master, env })
  assert.equal(calls, 2)
  await collectAdvanced(db, 'B', 'j', ['reddit'], 'q', { worker, master, env: { ...env, ADVANCED_KILL: '1' } })
  assert.equal(calls, 2)
})

test('worker output is validated: https only, quote length, bad shapes dropped', () => {
  assert.deepEqual(parseWorkerItems({ items: [{ ...item, login_walled: 'yes' }, { ...item, url: 'http://x.example' }, { ...item, quote: 'short' }, null, 'x'] }).map(i => i.login_walled), [false])
  assert.deepEqual(parseWorkerItems('nope'), [])
})
