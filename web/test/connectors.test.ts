import test from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { addEnrichment, audit, connectorStatus, getEnabledCredential, migrateConnectors, recentAudit, saveCredential, setEnabled, setEnrichFallback } from '../lib/connectors/store.ts'

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

test('#382: the enrich:fallback opt-in row is not a connector - hidden from status, never a credential', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  saveCredential(db, 't1', 'enrich:apollo', 'test-apollo-key-1234', master)
  setEnrichFallback(db, 't1', true)
  const status = await connectorStatus(sqliteDb(db), 't1')
  assert.deepEqual(status.map(s => s.connector), ['enrich:apollo']) // no phantom 'enrich:fallback' entry
  assert.equal(getEnabledCredential(db, 't1', 'enrich:fallback', master), null) // never decrypts to a usable key
})

test('#533: per-lead check:ats-board rows never displace connector audits in the last-20 settings display; they stay DB/support-readable', () => {
  const db = new Database(':memory:')
  migrateConnectors(db)
  audit(db, { tenantId: 't1', connector: 'signals:ats-gtm', jobId: 'j1', lookup: 'x', status: 'ok', results: 3 })
  for (let i = 0; i < 25; i++) audit(db, { tenantId: 't1', connector: 'check:ats-board', jobId: 'j1', lookup: `L${i} (gate) greenhouse`, status: 'checked_bound', results: 2 })
  const recent = recentAudit(db, 't1', 20) as { connector: string }[]
  assert.ok(recent.length > 0 && recent.every(r => !r.connector.startsWith('check:')), 'no check row floods the display')
  assert.ok(recent.some(r => r.connector === 'signals:ats-gtm'), 'the real connector audit is not displaced')
  assert.equal((db.prepare("SELECT COUNT(*) c FROM connector_audit WHERE connector = 'check:ats-board'").get() as { c: number }).c, 25, 'all check rows remain directly readable')
  db.close()
})
