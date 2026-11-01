import test from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateCompetitors, setCompetitors, listCompetitors, collectCompetitorComplaints, badgeComplaintLeads, complaintQuery, COMPLAINT_CONNECTOR } from '../lib/signals/competitor-reddit.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent } from '../lib/advanced/index.ts'

const ENV_ON = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://w.example', ADVANCED_WORKER_TOKEN: 't' } as Record<string,string>

function db() {
  const d = new Database(':memory:')
  migrateConnectors(d); migrateAdvanced(d); migrateCompetitors(d)
  d.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, source_url TEXT, signals TEXT)")
  return d
}

test('competitor list: max 5, cleaned, deduped, ordered', async () => {
  const d = db()
  const r = await setCompetitors(sqliteDb(d), 't1', [' Acme ', 'Acme', 'Globex', '', 'X  Corp'])
  assert.equal(r.ok, true)
  assert.deepEqual(listCompetitors(d, 't1'), ['Acme', 'Globex', 'X Corp'])
  assert.equal((await setCompetitors(sqliteDb(d), 't1', ['a1','a2','a3','a4','a5','a6'])).ok, false)
  assert.equal((await setCompetitors(sqliteDb(d), 't1', ['a'])).ok, false)
})

test('complaint query shape', async () => {
  assert.equal(complaintQuery('Acme'), 'Acme (complaint OR alternative OR hate OR cancel)')
})

test('collect: no consent skips with audit, no worker call', async () => {
  const d = db()
  await setCompetitors(sqliteDb(d), 't1', ['Acme'])
  let calls = 0
  const out = await collectCompetitorComplaints(d, 't1', 'j1', { worker: async () => { calls++; return { items: [], unsupported: null } }, env: ENV_ON })
  assert.equal(out.length, 0)
  assert.equal(calls, 0)
  const row = d.prepare("SELECT status FROM connector_audit WHERE connector = ?").get(COMPLAINT_CONNECTOR) as { status: string }
  assert.equal(row.status, 'no_consent')
})

test('collect: fresh posts only, tagged with the competitor, per-competitor audit', async () => {
  const d = db()
  await setCompetitors(sqliteDb(d), 't1', ['Acme'])
  acceptConsent(d, 't1', 'advanced')
  const recent = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10)
  const old = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
  const worker = async () => ({ unsupported: null, items: [
    { url: 'https://www.reddit.com/r/saas/a', title: 'Acme is terrible, alternatives?', quote: 'Acme keeps raising prices and support never answers.', date: recent, login_walled: false },
    { url: 'https://www.reddit.com/r/saas/b', title: 'old post', quote: 'an old complaint nobody should see now', date: old, login_walled: false },
  ] })
  const out = await collectCompetitorComplaints(d, 't1', 'j1', { worker, env: ENV_ON })
  assert.equal(out.length, 1)
  assert.equal(out[0].complaint_of, 'Acme')
  assert.equal(out[0].source, COMPLAINT_CONNECTOR)
  const row = d.prepare("SELECT status, results FROM connector_audit WHERE connector = ? AND status != 'no_consent'").get(COMPLAINT_CONNECTOR) as { status: string; results: number }
  assert.equal(row.status, 'ok')
  assert.equal(row.results, 1)
})

test('badge: lead citing a complaint post gets the tag merged, never duplicated', async () => {
  const d = db()
  d.prepare("INSERT INTO leads VALUES ('l1','j1','https://www.reddit.com/r/saas/a','[\"raised_funding\"]')").run()
  const n1 = badgeComplaintLeads(d, 'j1', [{ url: 'https://www.reddit.com/r/saas/a', complaint_of: 'Acme' }])
  const n2 = badgeComplaintLeads(d, 'j1', [{ url: 'https://www.reddit.com/r/saas/a', complaint_of: 'Acme' }])
  assert.equal(n1, 1)
  assert.equal(n2, 0)
  const row = d.prepare("SELECT signals FROM leads WHERE id = 'l1'").get() as { signals: string }
  assert.deepEqual(JSON.parse(row.signals), ['raised_funding', 'complained about Acme'])
})
