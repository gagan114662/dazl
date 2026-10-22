// Tenant binding of encrypted secrets: a ciphertext copied into another tenant's
// row must be unreadable. This is the GCM additional-data binding in lib/secrets.ts,
// exercised through the real per-tenant contexts each store uses. A failure here
// means one tenant's leaked ciphertext could be replayed as another tenant's secret.
// See docs/security/tenant-isolation-assessment.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { decryptSecret, encryptSecret } from '../lib/secrets.ts'
import { getKey, migrateKeys, readKey, saveKey } from '../lib/llm/key-store.ts'
import { getEnabledCredential, migrateConnectors, saveCredential } from '../lib/connectors/store.ts'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const master = randomBytes(32)

test('tenant context is part of the encryption: a blob sealed for A does not open as B', () => {
  const blob = encryptSecret('secret-value', `llm-key:${A}:anthropic`, master)
  assert.throws(() => decryptSecret(blob, `llm-key:${B}:anthropic`, master))
  assert.equal(decryptSecret(blob, `llm-key:${A}:anthropic`, master), 'secret-value')
})

test('LLM key ciphertext transplanted to another tenant is unreadable, not leaked', () => {
  const db = new Database(':memory:')
  migrateKeys(db)
  saveKey(db, A, 'anthropic', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', master)
  // Simulate a row-copy attack or a buggy JOIN: B's row now holds A's ciphertext.
  const stolen = (db.prepare('SELECT ciphertext FROM tenant_llm_keys WHERE tenant_id = ?').get(A) as { ciphertext: string }).ciphertext
  db.prepare('INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, ?, ?, ?, 0)').run(B, 'anthropic', stolen, 'aaaa')
  // The user-facing path reports the key as unreadable instead of returning A's secret.
  const r = readKey(db, B, 'anthropic', master)
  assert.equal(r.key, null)
  assert.equal(r.unreadable, true)
  // The throwing path used by the runner never yields the plaintext either.
  assert.throws(() => getKey(db, B, 'anthropic', master))
  // A's own row still works.
  assert.equal(getKey(db, A, 'anthropic', master), 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
})

test('connector credentials are bound the same way', () => {
  const db = new Database(':memory:')
  migrateConnectors(db)
  saveCredential(db, A, 'enrich:apollo', 'apollo-key-aaaaaaaaaaaaaaaa', master)
  assert.equal(getEnabledCredential(db, B, 'enrich:apollo', master), null)
  const stolen = (db.prepare('SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ?').get(A, 'enrich:apollo') as { ciphertext: string }).ciphertext
  db.prepare('INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4) VALUES (?, ?, ?, ?)').run(B, 'enrich:apollo', stolen, 'aaaa')
  assert.throws(() => getEnabledCredential(db, B, 'enrich:apollo', master))
  assert.equal(getEnabledCredential(db, A, 'enrich:apollo', master), 'apollo-key-aaaaaaaaaaaaaaaa')
})
