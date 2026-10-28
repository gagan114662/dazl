import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { openKeyRejection } from '../lib/llm/key-evidence.ts'

// Instinct #275: which key a scan used is not recorded (the runner picks the newest key when an attempt runs), so a
// rejection is never attributed to a key and clears only when every saved key was accepted again after the scan ended.
function fixture() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  const key = (vendor: string, created: number, tenant = 'A') =>
    db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, ?, 'x', 'ab12', ?, ?)").run(tenant, vendor, created, created)
  const resave = (vendor: string, at: number) => db.prepare('UPDATE tenant_llm_keys SET validated_at = ? WHERE tenant_id = ? AND vendor = ?').run(at, 'A', vendor)
  const remove = (vendor: string) => db.prepare('DELETE FROM tenant_llm_keys WHERE tenant_id = ? AND vendor = ?').run('A', vendor)
  const scan = (created: number, ended: number, status: 'done' | 'failed', error: string | null, o: { funded_by?: string; tenant?: string; attempts?: number } = {}) => {
    const id = createJob(db, o.tenant ?? 'A', { business_name: 'x', industry: 'test', location: 'test' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id)
    db.prepare('UPDATE scan_jobs SET status=?, error=?, created_at=?, finished_at=?, funded_by=?, attempts=? WHERE id=?').run(status, error, created, ended, o.funded_by ?? 'user', o.attempts ?? 1, id)
  }
  const snap = () => JSON.stringify([db.prepare('SELECT * FROM scan_jobs ORDER BY id').all(), db.prepare('SELECT * FROM tenant_llm_keys ORDER BY vendor').all()])
  return { key, resave, remove, scan, snap, rej: () => openKeyRejection(db, 'A') }
}
const OPEN = { error: 'key_rejected' }

test("Instinct's queued provider change: a key added while the scan was queued does not hide the rejection", () => {
  const f = fixture()
  f.key('anthropic', 100); f.scan(200, 300, 'failed', 'key_rejected'); f.key('openai', 250) // the run used OpenAI
  assert.deepEqual(f.rej(), OPEN)
  f.resave('openai', 400)
  assert.deepEqual(f.rej(), OPEN, 'Anthropic was never accepted again: not every saved key is proven')
  f.resave('anthropic', 410)
  assert.equal(f.rej(), null, 'every saved key accepted after the scan ended')
})

test('retries with a key change, deletion and re-add, and same-second saves keep it open', () => {
  const f = fixture()
  f.key('anthropic', 100); f.key('openai', 150)
  f.scan(200, 500, 'failed', 'key_rejected', { attempts: 3 }); f.resave('anthropic', 300) // re-saved between attempts
  assert.deepEqual(f.rej(), OPEN, 'a save during the run is not acceptance of whatever key the last attempt used')
  f.remove('openai'); f.key('openai', 450)
  assert.deepEqual(f.rej(), OPEN, 'a re-add during the run does not count either')
  f.resave('anthropic', 500); f.resave('openai', 500)
  assert.deepEqual(f.rej(), OPEN, 'same second as the scan ended: not strictly after')
  f.resave('anthropic', 501); f.resave('openai', 501)
  assert.equal(f.rej(), null)
})

test('cancelled, unrelated failed and done scans after a rejection never clear it; trial scans are never evidence', () => {
  const f = fixture()
  f.key('anthropic', 100); f.scan(200, 210, 'failed', 'key_unreadable')
  f.scan(300, 310, 'failed', 'cancelled'); f.scan(400, 410, 'failed', 'budget_stopped'); f.scan(500, 510, 'done', null)
  assert.deepEqual(f.rej(), { error: 'key_unreadable' }, 'a done scan cannot prove which key it used')
  f.resave('anthropic', 600); assert.equal(f.rej(), null)
  f.scan(700, 710, 'failed', 'key_rejected', { funded_by: 'trial' }); f.scan(700, 710, 'failed', 'key_rejected', { tenant: 'B' })
  assert.equal(f.rej(), null, 'free-search and other-tenant scans are ignored')
  const before = f.snap(); f.rej(); assert.equal(f.snap(), before, 'read-only')
})

test('deleting the rejected key leaves the remaining keys unproven until saved again; a legacy trial row before any key is cleared', () => {
  const f = fixture()
  f.key('anthropic', 100); f.key('openai', 150); f.scan(200, 300, 'failed', 'key_rejected'); f.remove('openai')
  assert.deepEqual(f.rej(), OPEN, 'which key was rejected is unknown, so the remaining one is not assumed fine')
  const g = fixture()
  g.scan(100, 110, 'failed', 'key_rejected'); g.key('anthropic', 200) // funded_by defaulted to user, before any key
  assert.equal(g.rej(), null)
})
