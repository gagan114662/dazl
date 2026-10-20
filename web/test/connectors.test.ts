import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { addEnrichment, audit, connectorStatus, enrichmentsForLeads, getEnabledCredential, migrateConnectors, recentAudit, saveCredential, setEnabled } from '../lib/connectors/store.ts'
import { parseDomainSearch, validateHunterKey } from '../lib/connectors/hunter.ts'
import { enrichJob } from '../lib/connectors/enrich.ts'

const master = randomBytes(32)
const KEY = 'h'.repeat(40)
const body = { data: { emails: [
  { value: 'ann@acme.com', type: 'personal', confidence: 91, first_name: 'Ann', last_name: 'Lee', position: 'Head of Sales', sources: [{ uri: 'https://acme.com/team', extracted_on: '2024-01-02', last_seen_on: '2026-09-01' }] },
  { value: 'nosource@acme.com', type: 'personal', confidence: 80, sources: [] },
  { value: 'baddate@acme.com', type: 'personal', confidence: 80, sources: [{ uri: 'https://acme.com/x', last_seen_on: 'yesterday' }] },
  { value: 'info@acme.com', type: 'generic', confidence: 70, sources: [{ uri: 'https://acme.com/contact', extracted_on: '2025-05-05' }] },
  { value: 'not-an-email', sources: [{ uri: 'https://a.com', extracted_on: '2025-05-05' }] },
] } }

test('hunter parsing keeps only emails with a dated source URL', () => {
  const r = parseDomainSearch(body, 1000)
  assert.equal(r.rawCount, 5)
  assert.deepEqual(r.enrichments.map(e => [e.value, e.kind, e.source_url, e.source_date]), [
    ['ann@acme.com', 'email', 'https://acme.com/team', '2026-09-01'],
    ['info@acme.com', 'generic_email', 'https://acme.com/contact', '2025-05-05'],
  ])
  assert.equal(parseDomainSearch(null).enrichments.length, 0)
})

test('credentials are encrypted, tenant bound, and only returned when enabled', () => {
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
  assert.equal(setEnabled(db, 't1', 'hunter', false), true)
  assert.equal(getEnabledCredential(db, 't1', 'hunter', master), null)
  assert.deepEqual(connectorStatus(db, 't1'), [{ connector: 'hunter', last4: 'hhhh', enabled: false }])
})

test('enrichJob enriches verified leads only, audits calls, and stops on auth failure', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES ('j1','t1','running','x','x','x')").run()
  const ins = db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, score, confidence, review_reason) VALUES (?, 'j1', ?, 's', 'https://a.com', ?, ?, ?)")
  ins.run('l1', 'Acme', 90, 80, null)
  ins.run('l2', 'ReviewCo', 85, null, 'blocked_by_site')
  saveCredential(db, 't1', 'hunter', KEY, master)
  const calls: string[] = []
  const f = (async (url: string, init: RequestInit) => { calls.push(String(url)); assert.equal((init.headers as Record<string, string>)['X-API-KEY'], KEY); return new Response(JSON.stringify(body), { status: 200 }) }) as unknown as typeof fetch
  await enrichJob(db, 't1', 'j1', { fetchImpl: f, master })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /company=Acme/)
  assert.ok(!calls[0].includes(KEY))
  const e = enrichmentsForLeads(db, 't1', ['l1', 'l2'])
  assert.equal(e.l1.length, 2)
  assert.equal(e.l2, undefined)
  assert.equal(enrichmentsForLeads(db, 't2', ['l1']).l1, undefined)
  assert.deepEqual(recentAudit(db, 't1').map(a => [(a as { lookup: string }).lookup, (a as { status: string }).status, (a as { results: number }).results]), [['Acme', 'ok', 2]])
  // disabled connector: no calls
  setEnabled(db, 't1', 'hunter', false)
  await enrichJob(db, 't1', 'j1', { fetchImpl: f, master })
  assert.equal(calls.length, 1)
  // auth failure is audited and stops further lookups
  setEnabled(db, 't1', 'hunter', true)
  ins.run('l3', 'Beta', 70, 70, null)
  const f401 = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
  await enrichJob(db, 't1', 'j1', { fetchImpl: f401, master })
  assert.equal(recentAudit(db, 't1').filter(a => (a as { status: string }).status === 'auth').length, 1)
})

test('enrichment rows require a source URL and a date', () => {
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

test('hunter key check maps statuses', async () => {
  const mk = (s: number) => (async () => new Response('{}', { status: s })) as unknown as typeof fetch
  assert.equal(await validateHunterKey(KEY, mk(200)), 'valid')
  assert.equal(await validateHunterKey(KEY, mk(401)), 'invalid')
  assert.equal(await validateHunterKey(KEY, mk(500)), 'unavailable')
})
