import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { openKeyRejection } from '../lib/llm/key-evidence.ts'

// Instinct #275: a rejection clears only on positive acceptance of that same key (provider- and key-specific).
function fixture() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  const key = (vendor: string, created: number, validated = created, tenant = 'A') =>
    db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, ?, 'x', 'ab12', ?, ?) ON CONFLICT(tenant_id, vendor) DO UPDATE SET validated_at = excluded.validated_at").run(tenant, vendor, validated, created)
  const resave = (vendor: string, at: number) => db.prepare('UPDATE tenant_llm_keys SET validated_at = ? WHERE tenant_id = ? AND vendor = ?').run(at, 'A', vendor)
  const scan = (created: number, status: 'done' | 'failed', error: string | null, o: { funded_by?: string; tenant?: string; ended?: number } = {}) => {
    const id = createJob(db, o.tenant ?? 'A', { business_name: 'x', industry: 'test', location: 'test' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id)
    db.prepare('UPDATE scan_jobs SET status=?, error=?, created_at=?, finished_at=?, funded_by=? WHERE id=?').run(status, error, created, o.ended ?? created + 10, o.funded_by ?? 'user', id)
    return id
  }
  const snap = () => JSON.stringify([db.prepare('SELECT * FROM scan_jobs ORDER BY id').all(), db.prepare('SELECT * FROM tenant_llm_keys ORDER BY vendor').all()])
  return { db, key, resave, scan, snap, rej: () => openKeyRejection(db, 'A') }
}

test('a rejection stays open through later cancelled and unrelated failed scans', () => {
  const f = fixture()
  f.key('anthropic', 100)
  f.scan(200, 'failed', 'key_rejected')
  assert.deepEqual(f.rej(), { error: 'key_rejected', vendor: 'anthropic' })
  f.scan(300, 'failed', 'cancelled'); f.scan(400, 'failed', 'budget_stopped'); f.scan(500, 'failed', 'upstream 502'); f.scan(600, 'failed', 'no_candidates')
  assert.deepEqual(f.rej(), { error: 'key_rejected', vendor: 'anthropic' }, 'none of these is acceptance of the key')
})

test("re-saving a different provider's key does not clear it while the rejected key is still the one scans use", () => {
  const f = fixture()
  f.key('openai', 100); f.key('anthropic', 150) // anthropic is newest by created_at, so scans use it
  f.scan(200, 'failed', 'key_rejected')
  f.resave('openai', 300) // updates validated_at only; created_at order (and the key scans use) is unchanged
  assert.deepEqual(f.rej(), { error: 'key_rejected', vendor: 'anthropic' })
  f.resave('anthropic', 400)
  assert.equal(f.rej(), null, 'saving that same key again (the provider accepted it) clears it')
})

test('a later done scan clears it only when it provably used that same, unchanged key; trial scans never count', () => {
  const f = fixture()
  f.key('anthropic', 100)
  f.scan(200, 'failed', 'key_rejected')
  f.scan(300, 'done', null, { funded_by: 'trial' })
  assert.notEqual(f.rej(), null, 'a free-search scan says nothing about this key')
  f.scan(400, 'done', null)
  assert.equal(f.rej(), null, 'the same key, not re-saved, finished a scan after the rejection')
})

test('a done scan on another provider, or before the rejection, does not clear it', () => {
  const f = fixture()
  f.key('anthropic', 100)
  f.scan(150, 'done', null)
  f.scan(200, 'failed', 'key_unreadable')
  assert.deepEqual(f.rej(), { error: 'key_unreadable', vendor: 'anthropic' })
  f.key('openai', 300) // now the newest key: scans use openai, the anthropic rejection no longer bears on them
  assert.equal(f.rej(), null)
  f.scan(400, 'failed', 'key_rejected')
  assert.deepEqual(f.rej(), { error: 'key_rejected', vendor: 'openai' })
})

test('unknown key identity: open until every current key is saved again; trial rejections and other tenants are ignored', () => {
  const f = fixture()
  f.scan(200, 'failed', 'key_rejected', { ended: 500 }) // no key existed when it was created: which key is unknown
  f.key('anthropic', 300)                               // added while it ran
  assert.deepEqual(f.rej(), { error: 'key_rejected', vendor: null })
  f.resave('anthropic', 600)
  assert.equal(f.rej(), null)
  f.scan(700, 'failed', 'key_rejected', { funded_by: 'trial' })
  f.scan(700, 'failed', 'key_rejected', { tenant: 'B' })
  assert.equal(f.rej(), null)
  const before = f.snap(); f.rej(); assert.equal(f.snap(), before, 'read-only')
})

test('a legacy trial rejection (funded_by defaulted to user, before any key) is cleared by the key saved afterwards', () => {
  const f = fixture()
  f.scan(100, 'failed', 'key_rejected')
  f.key('anthropic', 200)
  assert.equal(f.rej(), null)
})
