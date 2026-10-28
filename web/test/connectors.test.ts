import test from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { addEnrichment, audit, connectorStatus, enrichmentsForLeads, getEnabledCredential, migrateConnectors, recentAudit, saveCredential, setEnabled } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const KEY = 'h'.repeat(40)

test('credentials are encrypted, tenant bound, and only returned when enabled', async () => {
  const db = new Database(':memory:')
  migrateConnectors(db)
  saveCredential(db, 't1', 'hunter', KEY, master)
  const raw = db.prepare('SELECT ciphertext FROM tenant_connectors').get() as { ciphertext: string }
  assert.ok(!raw.ciphertext.includes(KEY))
  assert.equal(getEnabledCredential(db, 't1', 'hunter', master), KEY)
  assert.equal(getEnabledCredential(db, 't2', 'hunter', master), null)
  db.prepare("UPDATE tenant_connectors SET tenant_id = 't2'").run() // copied to another tenant: must not decrypt
  assert.throws(() => getEnabledCredential(db, 't2', 'hunter', master))
  db.prepare("UPDATE tenant_connectors SET tenant_id = 't1'").run()
  assert.equal(await setEnabled(sqliteDb(db), 't1', 'hunter', false), true)
  assert.equal(getEnabledCredential(db, 't1', 'hunter', master), null)
  assert.deepEqual(await connectorStatus(sqliteDb(db), 't1'), [{ connector: 'hunter', last4: 'hhhh', enabled: false }])
})

test('enrichment rows require a source URL and a date', async () => {
  const db = new Database(':memory:')
  migrateConnectors(db)
  const base = { connector: 'hunter', kind: 'email', value: 'a@b.co', label: null, confidence: 50, retrieved_at: 1 }
  assert.throws(() => addEnrichment(db, 't', 'l', { ...base, source_url: 'ftp://x', source_date: '2026-01-01' }))
  assert.throws(() => addEnrichment(db, 't', 'l', { ...base, source_url: 'https://x.co', source_date: '' }) )
  addEnrichment(db, 't', 'l', { ...base, source_url: 'https://x.co', source_date: '2026-01-01' })
  addEnrichment(db, 't', 'l', { ...base, source_url: 'https://x.co', source_date: '2026-01-01' }) // duplicate ignored
  assert.equal((db.prepare('SELECT count(*) c FROM lead_enrichments').get() as { c: number }).c, 1)
  audit(db, { tenantId: 't', connector: 'hunter', lookup: 'x', status: 'ok', results: 0 })
})

