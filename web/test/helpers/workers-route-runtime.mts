// The REAL /api/workers route (POST enqueue, GET list) on SQLite: until an operator has registered, started and granted a
// worker, no POST - whatever its body - writes a row (#623 review). Synthetic workers (test/fixtures/workers), no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { grant, register, start, stop } from '../../lib/workers/store.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { pin, TEST_REGISTRY } from './worker-registry.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-wr-')), 'app.db')
const { GET, POST } = await import('../../app/api/workers/route.ts')
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

const OP = 'op:tester', NOW = Math.floor(Date.now() / 1000)
let n = 0
const req = (body: unknown) => new NextRequest('http://localhost/api/workers', {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.4.0.${++n % 250}` },
  body: body instanceof Uint8Array || typeof body === 'string' ? body as BodyInit : JSON.stringify(body),
})
function setup() {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  for (const t of ['tenant-a', 'tenant-b']) raw.prepare('INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)').run(t, `${t}@example.test`, 'x', 'y')
  setUser({ id: 'tenant-a', business_name: 'A' })
  return { raw, db: sqliteDb(raw) }
}
const count = (raw: Database.Database, t: string) => (raw.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }).c
const tenantRows = (raw: Database.Database) => ({ worker_runs: count(raw, 'worker_runs'), work_queue: count(raw, 'work_queue'), audit_events: count(raw, 'audit_events') })
// the route's own limiter (60/min/tenant) is not what is measured here
const post = async (raw: Database.Database, body: unknown) => { raw.prepare('DELETE FROM rate_limits').run(); return POST(req(body)) }
const BIG = { n: 1, pad: 'x'.repeat(100_000) }
const BODIES: unknown[] = [
  { name: 'echo', input: { n: 1 } }, { name: 'echo', input: BIG }, { name: 'echo' }, { name: 'echo', input: null }, { name: 'echo', input: [1] },
  { name: 'echo', input: { n: 1 }, tenantId: 'tenant-b', extra: true }, { name: 'nope', input: { n: 1 } }, { name: 'unknown-worker', input: BIG },
  { name: ['echo'], input: { n: 1 } }, { name: { n: 'echo' }, input: { n: 1 } }, { name: null, input: { n: 1 } }, { name: true, input: { n: 1 } },
  { name: 7, input: { n: 1 } }, { input: { n: 1 } }, {}, { name: '' }, { name: 'x'.repeat(200_000) }, { name: 'echo\uD800' }, { name: 'ECHO' },
  { name: '__proto__' }, { name: 'worker:echo' },
]
// bodies the route refuses as bad_input before any lookup
const MALFORMED: unknown[] = ['not json', '', '[]', 'null', '"echo"', '7', 'true', '{"name":', new Uint8Array([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])]

async function noRows(raw: Database.Database, label: string) {
  const audits = count(raw, 'audit_events') // the operator's grants are audit events; a refused POST adds none
  for (const b of BODIES) {
    for (let k = 0; k < 2; k++) {
      const r = await post(raw, b)
      assert.equal(r.status, 404, `${label}: ${JSON.stringify(b).slice(0, 60)}`)
      assert.deepEqual(await r.json(), { error: 'unavailable' })
    }
  }
  for (const b of MALFORMED) {
    const r = await post(raw, b)
    assert.ok(r.status === 400 || r.status === 404, `${label}: ${String(b)} -> ${r.status}`)
  }
  const many = await Promise.all(Array.from({ length: 30 }, (_, i) => POST(req({ name: i % 2 ? 'echo' : `w-${i}`, input: { n: i } }))))
  assert.ok(many.every(r => r.status === 404 || r.status === 429), label)
  assert.deepEqual(tenantRows(raw), { worker_runs: 0, work_queue: 0, audit_events: audits }, label)
}

test('POST to an unknown, not-running or not-granted worker: 404 unavailable for every body, and worker_runs stays empty', async () => {
  const { raw, db } = setup()
  await noRows(raw, 'nothing registered')
  await register(db, OP, { name: 'echo', version: '1.0.0', codeHash: pin('echo', '1.0.0') }, TEST_REGISTRY, NOW)
  await noRows(raw, 'registered, not running')
  await start(db, OP, 'echo', '1.0.0', NOW)
  await noRows(raw, 'running, not granted')
  await grant(db, OP, 'tenant-b', 'echo', NOW)
  await noRows(raw, "granted to another tenant only (tenant-b's worker name)")
  await grant(db, OP, 'tenant-a', 'echo', NOW)
  await stop(db, OP, 'echo', { mode: 'fence' }, NOW)
  await noRows(raw, 'granted, stopped')
  // the session's GET shows nothing either
  const g = await GET(); assert.equal(g.status, 200); assert.deepEqual(await g.json(), { runs: [] })
})

test('running and granted: a valid POST is 202 and audited; bad_input is recorded as a refused run without the input', async () => {
  const { raw, db } = setup()
  await register(db, OP, { name: 'echo', version: '1.0.0', codeHash: pin('echo', '1.0.0') }, TEST_REGISTRY, NOW)
  await start(db, OP, 'echo', '1.0.0', NOW)
  await grant(db, OP, 'tenant-a', 'echo', NOW)
  const ok = await post(raw, { name: 'echo', input: { n: 3 } })
  assert.equal(ok.status, 202)
  const bad = await post(raw, { name: 'echo', input: { n: 'leak-me' } })
  assert.equal(bad.status, 400)
  const runs = raw.prepare('SELECT status, input FROM worker_runs ORDER BY status').all() as { status: string; input: string }[]
  assert.deepEqual(runs.map(r => r.status), ['queued', 'refused'])
  assert.equal(runs[1].input, 'null')
  assert.deepEqual((raw.prepare('SELECT action FROM audit_events').all() as { action: string }[]).map(r => r.action).sort(), ['worker.enqueue', 'worker.grant'])
  setUser({ id: 'tenant-a', business_name: 'A', role: 'viewer' })
  assert.equal((await post(raw, { name: 'echo', input: { n: 1 } })).status, 403)
  assert.equal(count(raw, 'worker_runs'), 2)
})
