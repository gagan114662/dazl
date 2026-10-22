import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, readKey, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, getJob } from '../lib/scan/store.ts'
import { migratePlans, setPlan } from '../lib/plans.ts'
import { claimKeyedJob, previewIcp, runJob } from '../lib/scan/runner.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function setup(tenant = 'A') {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db)
  saveKey(db, tenant, 'anthropic', KEY, master)
  return db
}

test('readKey: good row reads, missing row is null, corrupt row is unreadable instead of throwing', () => {
  const db = setup()
  assert.deepEqual(readKey(db, 'A', 'anthropic', master), { key: KEY, unreadable: false })
  assert.deepEqual(readKey(db, 'A', 'openai', master), { key: null, unreadable: false })
  db.prepare("UPDATE tenant_llm_keys SET ciphertext = 'not-json' WHERE tenant_id = 'A'").run()
  const r = readKey(db, 'A', 'anthropic', master)
  assert.equal(r.key, null)
  assert.equal(r.unreadable, true)
})

test('readKey: ciphertext copied from another tenant is unreadable (context binds it to the tenant)', () => {
  const db = setup()
  const row = db.prepare('SELECT ciphertext FROM tenant_llm_keys WHERE tenant_id = ?').get('A') as { ciphertext: string }
  db.prepare('INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, ?, ?, ?, ?)').run('B', 'anthropic', row.ciphertext, 'AAAA', 1)
  assert.equal(readKey(db, 'B', 'anthropic', master).unreadable, true)
  assert.equal(readKey(db, 'A', 'anthropic', master).key, KEY)
})

test('previewIcp: corrupt stored key returns key_unreadable, not a 500 and not no_api_key', async () => {
  const db = setup()
  db.prepare("UPDATE tenant_llm_keys SET ciphertext = 'not-json' WHERE tenant_id = 'A'").run()
  const out = await previewIcp(db, 'A', 'companies hiring a sales operations manager', { master })
  assert.deepEqual(out, { error: 'key_unreadable' })
})

test('runJob: corrupt stored key fails the job visibly instead of crash-looping in running', async () => {
  const db = setup()
  setPlan(db, 'A', 'pro')
  db.prepare("UPDATE tenant_llm_keys SET ciphertext = 'not-json' WHERE tenant_id = 'A'").run()
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query) VALUES ('j1', 'A', 'Acme', 'B2B', 'US', ?)").run('companies hiring a sales operations manager')
  const job = claimKeyedJob(db)
  assert.ok(job)
  assert.equal(await runJob(db, job!, { master }), 'failed')
  const j = getJob(db, 'A', job!.id)
  assert.equal(j?.status, 'failed')
  assert.equal(j?.error, 'key_unreadable')
})
