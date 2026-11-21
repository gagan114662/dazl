import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { GET } from '../../app/api/scan/status/route.ts'

// #1157 (Quest, prod cc90b98c, run 8df272f3): the running page said "Searching... 0 min" for over a minute. Read through the
// real status route the page polls (no readonly flag: the same reap the poller runs). No key, no network: nothing is sent.
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced in running-since harness: ${String(u)}`) }) as typeof fetch

test('a running scan reports when it started running, not its last lease renewal', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); setScanDb(db)
  const now = Math.floor(Date.now() / 1000)
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'Manufacturing', location: 'Bangalore, India' })
  // Real prod shape (staging job 3e7778a5, the ledger Hermes read for this issue): one model call, three TinyFish searches
  // and a fetch, all settled (TinyFish at US$0), then the extraction model call reserved US$0.084666. Here spread over the
  // 150 s the scan has been running; every reserve and settle renewed claimed_at, the last one 4 s ago.
  db.prepare("UPDATE scan_jobs SET created_at = ?, status = 'running', attempts = 1, claimed_at = ? WHERE id = ?").run(now - 152, now - 4, id)
  const ins = db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, 'A', ?, 1, ?, ?, ?, ?, NULL, ?, ?)")
  ins.run('m1', id, 'llm.anthropic', 0.0211, 0.0019, 'settled', now - 150, now - 146)
  ins.run('s1', id, 'tinyfish.search', 0, 0, 'settled', now - 145, now - 140)
  ins.run('s2', id, 'tinyfish.search', 0, 0, 'settled', now - 139, now - 120)
  ins.run('s3', id, 'tinyfish.search', 0, 0, 'settled', now - 119, now - 90)
  ins.run('f1', id, 'tinyfish.fetch', 0, 0, 'settled', now - 89, now - 30)
  ins.run('m2', id, 'llm.anthropic', 0.084666, null, 'reserved', now - 4, null)
  const res = await GET(new NextRequest(`http://localhost/api/scan/status?job_id=${id}&passive=1`))
  assert.equal(res.status, 200)
  const j = await res.json() as { status: string; claimed_at: number; running_since?: number | null; last_progress_at: number | null }
  assert.equal(j.status, 'running')
  assert.equal(j.last_progress_at, now - 4, 'last activity is the newest call')
  assert.equal(j.running_since, now - 152, 'running since the user started the scan: 2 min, not the 4 s since the lease was renewed')
  assert.ok(Math.floor((now - j.running_since!) / 60) >= 2)
  db.close()
})

test('a free opening phase (no spend rows, lease renewed at each phase boundary) still counts from the start; pending has no running time', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); setScanDb(db)
  const now = Math.floor(Date.now() / 1000)
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'Manufacturing', location: 'Bangalore, India' })
  let j = await (await GET(new NextRequest(`http://localhost/api/scan/status?job_id=${id}&passive=1`))).json() as { running_since?: number | null }
  assert.equal(j.running_since, null, 'pending: never an invented start time')
  db.prepare("UPDATE scan_jobs SET created_at = ?, status = 'running', attempts = 1, claimed_at = ? WHERE id = ?").run(now - 95, now - 3, id)
  j = await (await GET(new NextRequest(`http://localhost/api/scan/status?job_id=${id}&passive=1`))).json() as { running_since?: number | null }
  assert.equal(j.running_since, now - 95, 'never the renewed lease (now - 3): that read "0 min" on a working scan')
  db.close()
})
