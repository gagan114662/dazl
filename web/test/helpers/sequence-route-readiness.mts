import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { setScanDb } from './sequence-route-db.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateAutopilot } from '../../lib/outreach/autopilot.ts'
import { migrateLedger } from '../../lib/outreach/ledger.ts'
import { migrateReplies } from '../../lib/outreach/replies.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { NextRequest } from 'next/server'
import { GET } from '../../app/api/outreach/sequences/route.ts'

// Real GET route; the stubbed requireUser is tenant 'A'. No network, no provider.
globalThis.fetch = (async (u: unknown) => { throw new Error('Unexpected network attempt: ' + String(u)) }) as typeof fetch
type Resp = { scheduler: string; gates: { id: string; ok: boolean; scope: string }[] }
const get = async () => { const r = await GET(new NextRequest('http://localhost/api/outreach/sequences')); assert.equal(r.status, 200); return await r.json() as Resp }
const row = (db: Database.Database, tenant: string, id: string) =>
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status) VALUES (?,?,?,?,?,?,'uncertain')").run(id, tenant, 'l' + id, 'x@example.test', 's', 'This is a synthetic body for the route test.')

test('GET returns scheduler and account-scoped gates; another tenant uncertain send does not leak, own does', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  setScanDb(db)
  delete process.env.SEQUENCES_ENABLED; delete process.env.AUTOPILOT_KILL
  assert.equal((await get()).scheduler, 'operator_off')
  process.env.SEQUENCES_ENABLED = '1'
  let b = await get()
  assert.equal(b.scheduler, 'configured_on')
  assert.deepEqual(b.gates.map(g => [g.id, g.scope]), [['gmail', 'account'], ['read_consent', 'account'], ['sender_identity', 'account'], ['uncertain_send', 'account']])
  row(db, 'B', 'b1')
  assert.equal((await get()).gates.find(g => g.id === 'uncertain_send')!.ok, true, 'tenant B uncertain row must not block tenant A')
  row(db, 'A', 'a1')
  assert.equal((await get()).gates.find(g => g.id === 'uncertain_send')!.ok, false, 'own uncertain row blocks')
  process.env.AUTOPILOT_KILL = '1'
  assert.equal((await get()).scheduler, 'kill_switch')
})
