import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
// @ts-expect-error test shim export
import { flushAfter } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { migrateScan, createJob, getJob } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { GET } from '../../app/api/scan/status/route.ts'

// Route-behavior harness for the status-poll runner kick. Synthetic key, no network:
// global fetch throws, so a kicked runner claims the job (attempts bump) and its
// provider attempt immediately fails back to a retry-pending state. The OBSERVABLE
// of the kick is the attempts bump + error, not any provider success.
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced in status-kick harness: ${String(u)}`) }) as typeof fetch

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-synthetic-test-key')
  setScanDb(db)
  return db
}
const get = (id: string, passive: boolean) =>
  GET(new NextRequest(`http://localhost/api/scan/status?job_id=${id}${passive ? '&passive=1' : ''}`))
const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT status, error, attempts, claimed_at FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; attempts: number; claimed_at: number | null }
// Wait until the kicked runner's claim is visible. One kick = one claim: the fenced
// provider call fails the attempt, the job re-pends, and RETRIES are driven by later
// kicks (that is the pre-existing poll-driven retry model this harness documents).
async function settle(db: Database.Database, id: string, wantAttempts: number, timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    const r = row(db, id)
    if (r.attempts >= wantAttempts && r.claimed_at === null && r.error !== null) {
      assert.equal(r.status, 'pending', 'fenced attempt re-pends for a later kick')
      assert.ok(r.error, 'the fenced provider failure is recorded honestly')
      assert.equal(r.claimed_at, null, 'runner released the job after the failed attempt')
      return r
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`kick not observed: ${JSON.stringify(r)}`)
    await new Promise(res => setTimeout(res, 25))
  }
}

test('ordinary (non-passive) status poll of a pending job kicks the runner: job gets claimed', async () => {
  const db = setup()
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'i', location: 'l' })
  const res = await get(id, false)
  assert.equal(res.status, 200)
  await flushAfter()
  await settle(db, id, 1)
  db.close()
})

test('passive=1 status poll of a pending job starts no provider work: never claimed', async () => {
  const db = setup()
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'i', location: 'l' })
  const res = await get(id, true)
  assert.equal(res.status, 200)
  const j = await res.json() as { status: string; attempts: number }
  assert.equal(j.status, 'pending'); assert.equal(j.attempts, 0)
  await flushAfter()
  const r = row(db, id)
  assert.equal(r.attempts, 0, 'passive poll must not claim')
  assert.equal(r.status, 'pending')
  assert.equal(r.claimed_at, null)
  db.close()
})

test('passive=1 is still stateful: getJob reaps a stale-running job to pending, but no re-claim follows', async () => {
  const db = setup()
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'i', location: 'l' })
  db.prepare("UPDATE scan_jobs SET status='running', attempts=1, claimed_at=CAST(strftime('%s','now') AS INTEGER)-3600 WHERE id=?").run(id)
  const res = await get(id, true)
  assert.equal(res.status, 200)
  const j = await res.json() as { status: string; attempts: number }
  assert.equal(j.status, 'pending', 'the reap is a WRITE: passive is no-kick, not read-only')
  assert.equal(j.attempts, 1)
  await flushAfter()
  assert.equal(row(db, id).attempts, 1, 'no re-claim without a kick')
  db.close()
})

test('after the same stale reap, a non-passive poll does re-claim (recovery path preserved)', async () => {
  const db = setup()
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'i', location: 'l' })
  db.prepare("UPDATE scan_jobs SET status='running', attempts=1, claimed_at=CAST(strftime('%s','now') AS INTEGER)-3600 WHERE id=?").run(id)
  const res = await get(id, false)
  assert.equal(res.status, 200)
  await flushAfter()
  await settle(db, id, 2)
  db.close()
})
