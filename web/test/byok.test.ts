import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { decryptSecret, encryptSecret } from '../lib/secrets.ts'
import { deleteKey, getKey, keyStatus, migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { looksLikeKey, validateKey } from '../lib/llm/vendors.ts'
import { migratePlans, scanQuota } from '../lib/plans.ts'
import { setPlan } from './helpers/plan-fixture.ts'
import { createJob, migrateScan } from '../lib/scan/store.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

test('encrypt/decrypt round trip; ciphertext does not contain the secret', () => {
  const blob = encryptSecret(KEY, 'ctx', master)
  assert.ok(!blob.includes(KEY))
  assert.equal(decryptSecret(blob, 'ctx', master), KEY)
  assert.notEqual(encryptSecret(KEY, 'ctx', master), blob) // fresh data key and IV each time
})

test('wrong master key, wrong context and tampering all fail', () => {
  const blob = encryptSecret(KEY, 'ctx', master)
  assert.throws(() => decryptSecret(blob, 'ctx', randomBytes(32)))
  assert.throws(() => decryptSecret(blob, 'other-ctx', master))
  const o = JSON.parse(blob)
  const ctBytes = Buffer.from(o.ct, 'base64')
  ctBytes[0] ^= 1
  o.ct = ctBytes.toString('base64')
  assert.throws(() => decryptSecret(JSON.stringify(o), 'ctx', master))
})

test('keys are stored per tenant, status never exposes the key, and delete revokes', () => {
  const db = new Database(':memory:')
  migrateKeys(db)
  saveKey(db, 'a', 'anthropic', KEY, master)
  assert.equal(getKey(db, 'a', 'anthropic', master), KEY)
  assert.equal(getKey(db, 'b', 'anthropic', master), null)
  const st = keyStatus(db, 'a')
  assert.equal(st[0].last4, KEY.slice(-4))
  assert.ok(!JSON.stringify(st).includes(KEY))
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM tenant_llm_keys').all()).includes(KEY))
  // a row copied to another tenant cannot be decrypted there
  const row = db.prepare('SELECT ciphertext FROM tenant_llm_keys').get() as { ciphertext: string }
  db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES ('b','anthropic',?, 'x', 1)").run(row.ciphertext)
  assert.throws(() => getKey(db, 'b', 'anthropic', master))
  assert.equal(deleteKey(db, 'a', 'anthropic'), true)
  assert.equal(getKey(db, 'a', 'anthropic', master), null)
})

test('key shape and vendor validation (mocked fetch)', async () => {
  assert.equal(looksLikeKey('anthropic', KEY), true)
  assert.equal(looksLikeKey('anthropic', 'nope'), false)
  assert.equal(looksLikeKey('openai', 'sk-' + 'a'.repeat(40)), true)
  const mk = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch
  assert.equal(await validateKey('anthropic', KEY, mk(200)), 'valid')
  assert.equal(await validateKey('anthropic', KEY, mk(401)), 'invalid')
  const d: { message?: string } = {}
  const f400 = (async () => new Response(JSON.stringify({ error: { message: 'This API key is not scoped to a workspace' } }), { status: 400 })) as unknown as typeof fetch
  assert.equal(await validateKey('anthropic', KEY, f400, d), 'rejected')
  assert.equal(d.message, 'This API key is not scoped to a workspace')
  assert.equal(await validateKey('openai', 'sk-' + 'a'.repeat(40), mk(429)), 'unavailable')
  assert.equal(await validateKey('openai', 'sk-' + 'a'.repeat(40), (async () => { throw new Error('net') }) as unknown as typeof fetch), 'unavailable')
})

test('scan quota: free = 50 per month, pro unlimited, per tenant', () => {
  const db = new Database(':memory:')
  migrateScan(db); migratePlans(db)
  const input = { business_name: 'A', industry: 'i', location: 'l' }
  for (let i = 0; i < 49; i++) createJob(db, 'a', input)
  assert.equal(scanQuota(db, 'a').allowed, true)
  createJob(db, 'a', input)
  assert.equal(scanQuota(db, 'a').allowed, false)
  assert.equal(scanQuota(db, 'b').allowed, true)
  setPlan(db, 'a', 'pro')
  assert.equal(scanQuota(db, 'a').allowed, true)
  assert.equal(scanQuota(db, 'a').limit, null)
  // last month's scans do not count
  assert.equal(scanQuota(db, 'a', new Date(Date.UTC(2099, 0, 15))).used, 0)
})

test('hasKey is true only for tenants that saved a key', async () => {
  const { hasKey } = await import('../lib/llm/key-store.ts')
  const db = new Database(':memory:')
  migrateKeys(db)
  assert.equal(hasKey(db, 'A'), false)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', Buffer.alloc(32, 7))
  assert.equal(hasKey(db, 'A'), true)
  assert.equal(hasKey(db, 'B'), false)
})
