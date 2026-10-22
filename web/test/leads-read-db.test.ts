import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteLeadsRead } from '../lib/db/leads-read.ts'
import { migrateScan, getJob, listLeads, countHiddenLeads } from '../lib/scan/store.ts'
import { migrateEvents, eventsForLeads } from '../lib/events/store.ts'
import { leadPriorities } from '../lib/events/prioritize.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateSequences, sequenceStatusByLead } from '../lib/outreach/sequences.ts'
import { createRankingFixture } from '../lib/scan/ranking-fixture.ts'
import { lookalikeSignals } from '../lib/scan/lookalike.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'

// Contract test for the GET /api/leads read slice. The SQLite adapter must
// return results identical to the existing sync store calls on the same
// synthetic data. A future Postgres implementation of LeadsReadDb must satisfy
// this same contract; that is what makes the slice a measured port pattern.
const TENANT = 'test-tenant-ranking'

function db() {
  const d = new Database(':memory:')
  migrateScan(d); migrateEvents(d); migrateOutreach(d); migrateSequences(d); migrateConnectors(d); migrateReplies(d)
  d.prepare('INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES (?, ?)').run(TENANT, JSON.stringify([TEST_INBOX]))
  process.env.OUTREACH_TEST_TENANT_ID = TENANT
  try { createRankingFixture(d, TENANT) } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
  return d
}

test('sqlite adapter matches direct sync calls on synthetic data', async () => {
  const d = db()
  const jobId = (d.prepare('SELECT id FROM scan_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(TENANT) as { id: string }).id
  const api = sqliteLeadsRead(d)

  assert.deepEqual(await api.getJob(TENANT, jobId), getJob(d, TENANT, jobId))

  const viaApi = await api.listLeads(TENANT, jobId, 200, false) as { id: string; company_domain: string | null; signal: string; fit: number | null; intent: number | null; action: number | null }[]
  const direct = listLeads(d, TENANT, jobId, 200, false) as typeof viaApi
  assert.deepEqual(viaApi, direct)
  assert.ok(viaApi.length > 0)

  assert.equal(await api.countHiddenLeads(TENANT, jobId), countHiddenLeads(d, TENANT, jobId))
  assert.deepEqual(await api.sequenceStatusByLead(TENANT), sequenceStatusByLead(d, TENANT))
  assert.deepEqual(await api.enrichmentsForLeads(TENANT, viaApi.map(l => l.id)), {})
  assert.deepEqual(await api.eventsForLeads(TENANT, viaApi), eventsForLeads(d, TENANT, viaApi))
  assert.deepEqual(await api.leadPriorities(TENANT, viaApi), leadPriorities(d, TENANT, viaApi))
  const lookInput = viaApi.map(l => ({ id: l.id, signal: l.signal }))
  assert.deepEqual(await api.lookalikeSignals(TENANT, lookInput), lookalikeSignals(d, TENANT, lookInput))
})

test('adapter is async-shaped (returns promises) so the route compiles against either backend', async () => {
  const d = db()
  const api = sqliteLeadsRead(d)
  const p = api.countHiddenLeads(TENANT, 'nonexistent-job-id-0000')
  assert.ok(p instanceof Promise)
  assert.equal(await p, 0)
})
