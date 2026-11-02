// #436: an unsupported adapter is an honest 'unsupported' outcome end to end - the scan audits it,
// no session is collected for it, no worker call is made for it, and a real worker over the wire
// reports the same outcome. Synthetic only: loopback worker, throwaway DB, no live platform calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { migrateConnectors, saveCredential, recentAudit } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent, collectAdvanced, httpWorker, parseWorkerReply, type WorkerFetch } from '../lib/advanced/index.ts'

const master = randomBytes(32)
const ON: Record<string, string | undefined> = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'http://worker.internal:9000', ADVANCED_WORKER_TOKEN: 't' }
function setup() { const db = new Database(':memory:'); migrateConnectors(db); migrateAdvanced(db); return db }
const statuses = (db: Database.Database, t: string) => (recentAudit(db, t, 50) as { connector: string; status: string }[]).map(r => `${r.connector}:${r.status}`)

test('unsupported platform: audited unsupported without consent, worker or budget; supported platforms still run', async () => {
  const db = setup()
  let calls = 0
  const worker: WorkerFetch = async () => { calls++; return { items: [], unsupported: null } }
  acceptConsent(db, 'A', 'advanced')
  saveCredential(db, 'A', 'adv:facebook', 'session-of-tenant-A-1234', master)
  const out = await collectAdvanced(db, 'A', 'j1', ['facebook', 'xiaohongshu', 'reddit'], 'q', { worker, master, env: ON })
  assert.deepEqual(out, [])
  assert.equal(calls, 1, 'only reddit reaches the worker')
  const st = statuses(db, 'A')
  assert.ok(st.includes('adv:facebook:unsupported'), st.join(','))
  assert.ok(st.includes('adv:xiaohongshu:unsupported'), st.join(','))
  assert.ok(st.includes('adv:reddit:empty'), st.join(','))
})

test('version skew: a worker refusal is audited unsupported, never empty or worker_error', async () => {
  const db = setup(); acceptConsent(db, 'A', 'advanced')
  const worker: WorkerFetch = async () => ({ items: [], unsupported: 'not implemented by the worker' })
  const out = await collectAdvanced(db, 'A', 'j1', ['reddit'], 'q', { worker, master, env: ON })
  assert.deepEqual(out, [])
  assert.ok(statuses(db, 'A').includes('adv:reddit:unsupported'))
})

test('reply parsing: only the exact unsupported outcome reads as a refusal', () => {
  assert.deepEqual(parseWorkerReply({ items: [], outcome: 'unsupported', reason: 'r' }), { items: [], unsupported: 'r' })
  assert.equal(parseWorkerReply({ items: [], outcome: 'unsupported' }).unsupported, 'not implemented by the worker')
  assert.equal(parseWorkerReply({ items: [] }).unsupported, null)
  assert.equal(parseWorkerReply({ items: [], outcome: 'unsupportd' }).unsupported, null)
  assert.equal(parseWorkerReply(null).unsupported, null)
})

test('over the wire: the real worker reports unsupported for facebook, with no items', async () => {
  const port = 4700 + Math.floor(Math.random() * 300)
  const token = 'e2e-token'
  const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', '../session-worker/src/server.ts'], {
    env: { ...process.env, ADVANCED_WORKER_TOKEN: token, PORT: String(port) }, stdio: 'ignore',
  })
  try {
    const base = `http://127.0.0.1:${port}`
    let up = false
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok } catch { await new Promise(r => setTimeout(r, 100)) } }
    assert.ok(up, 'worker did not start')
    const worker = httpWorker({ ADVANCED_WORKER_URL: base, ADVANCED_WORKER_TOKEN: token })
    const r = await worker({ platform: 'facebook', query: 'hiring sales', session: 's'.repeat(20) })
    assert.ok(r !== null)
    assert.deepEqual(r.items, [])
    assert.match(r.unsupported ?? '', /browser worker/)
  } finally { child.kill() }
})
