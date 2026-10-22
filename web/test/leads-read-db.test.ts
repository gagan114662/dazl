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

// Cross-backend contract: the pg-mem Postgres implementation must return results
// identical to the SQLite adapter on the same synthetic rows. pg-mem is an
// in-memory Postgres EMULATION - this proves SQL dialect translation and result
// shape, not wire-protocol or production pg behavior (that needs the real-pg
// rehearsal). Both sides get byte-identical seed rows.
test('pg-mem implementation matches sqlite adapter on identical synthetic rows', async () => {
  const { newDb, DataType } = await import('pg-mem')
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const mem = newDb()
  mem.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (x: string) => x.length, impure: false })
  mem.public.registerFunction({ name: 'btrim', args: [DataType.text], returns: DataType.text, implementation: (x: string) => x.trim(), impure: false })
  mem.public.registerFunction({ name: 'floor', args: [DataType.float], returns: DataType.float, implementation: (x: number) => Math.floor(x), impure: false })
  mem.public.none(readFileSync(new URL('../scripts/pg-migrate/schema.sql', import.meta.url), 'utf8'))
  const { Pool } = mem.adapters.createPg()
  const pool = new Pool()
  const { pgLeadsRead } = await import('../lib/db/leads-read-pg.ts')

  const T = 't1', J = 'job000000000000000000001'
  const now = 1800000000
  const seedSqlite = (d: InstanceType<typeof Database>) => {
    d.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, query) VALUES (?, ?, 'running', 'Biz', 'software', 'Toronto', ?, 'q')").run(J, T, now - 100)
    const ins = d.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, created_at, fit, intent, action, company_domain) VALUES (?, ?, '', ?, NULL, ?, 'https://example.com/jobs/1', 80, ?, ?, ?, ?, ?)")
    ins.run('L1', J, 'Acme', 'Hiring sales operations manager', now - 90, 5, 4, 3, 'acme.com')
    ins.run('L2', J, 'Hidden Co', 'weak signal here', now - 80, 1, 1, 1, null)
    ins.run('L3', J, 'Beta', 'Sales operations manager needed', now - 70, 4, 4, 4, null)
    ins.run('L4', J, 'Gamma', 'CRM administrator and sales operations', now - 60, 4, 4, 4, null)
    ins.run('L5', J, 'Delta', 'sales operations lead opening', now - 50, 4, 4, 4, null)
    d.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(J)
    d.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, created_at) VALUES ('M1', ?, 'L1', 'a@b.c', 's', '01234567890123456789', 'sent', 1000, 999)").run(T)
    d.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status, created_at) VALUES ('S1', ?, 'L1', 'M1', 'a@b.c', 'active', 998)").run(T)
    d.prepare("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status, sent_at, created_at) VALUES (?, 'S1', 2, 's2', '01234567890123456789', 'sent', 2000, 997)").run(T)
    d.prepare("INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES (?, '[]')").run(T)
    d.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('E1', 'L1', ?, 'apollo', 'person', 'Ada', 'Head of Sales', 90, 'https://apollo.io/x', '2026-10-01', 3000)").run(T)
    d.prepare("INSERT INTO company_events (id, tenant_id, company_key, company_name, scope, lead_id, event_type, summary, detail, source_url, source_published_at, retrieved_at, first_seen_at, last_seen_at, confidence) VALUES ('V1', ?, 'acme.com', 'Acme', 'account', 'L1', 'funding_round', 'Raised', NULL, 'https://news.example/a', '2026-10-01', 4000, 3900, 4000, 80)").run(T)
  }
  const seedPg = async () => {
    const q = (t: string, p: unknown[]) => pool.query(t, p)
    await q("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, query) VALUES ($1, $2, 'done', 'Biz', 'software', 'Toronto', $3, 'q')", [J, T, now - 100])
    const ins = "INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, created_at, fit, intent, action, company_domain) VALUES ($1, $2, '', $3, NULL, $4, 'https://example.com/jobs/1', 80, $5, $6, $7, $8, $9)"
    await q(ins, ['L1', J, 'Acme', 'Hiring sales operations manager', now - 90, 5, 4, 3, 'acme.com'])
    await q(ins, ['L2', J, 'Hidden Co', 'weak signal here', now - 80, 1, 1, 1, null])
    await q(ins, ['L3', J, 'Beta', 'Sales operations manager needed', now - 70, 4, 4, 4, null])
    await q(ins, ['L4', J, 'Gamma', 'CRM administrator and sales operations', now - 60, 4, 4, 4, null])
    await q(ins, ['L5', J, 'Delta', 'sales operations lead opening', now - 50, 4, 4, 4, null])
    await q("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, created_at) VALUES ('M1', $1, 'L1', 'a@b.c', 's', '01234567890123456789', 'sent', 1000, 999)", [T])
    await q("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status, created_at) VALUES ('S1', $1, 'L1', 'M1', 'a@b.c', 'active', 998)", [T])
    await q("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status, sent_at, created_at) VALUES ($1, 'S1', 2, 's2', '01234567890123456789', 'sent', 2000, 997)", [T])
    await q("INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES ($1, '[]')", [T])
    await q("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('E1', 'L1', $1, 'apollo', 'person', 'Ada', 'Head of Sales', 90, 'https://apollo.io/x', '2026-10-01', 3000)", [T])
    await q("INSERT INTO company_events (id, tenant_id, company_key, company_name, scope, lead_id, event_type, summary, detail, source_url, source_published_at, retrieved_at, first_seen_at, last_seen_at, confidence) VALUES ('V1', $1, 'acme.com', 'Acme', 'account', 'L1', 'funding_round', 'Raised', NULL, 'https://news.example/a', '2026-10-01', 4000, 3900, 4000, 80)", [T])
  }

  const d = db()
  seedSqlite(d)
  await seedPg()
  const lite = sqliteLeadsRead(d)
  const pg = pgLeadsRead(pool as never)

  const [jobL, jobP] = await Promise.all([lite.getJob(T, J), pg.getJob(T, J)])
  assert.deepEqual(jobP, jobL)

  const leadsL = await lite.listLeads(T, J, 200, false) as { id: string; company_domain: string | null; signal: string; fit: number | null; intent: number | null; action: number | null }[]
  const leadsP = await pg.listLeads(T, J, 200, false) as typeof leadsL
  assert.deepEqual(leadsP.map(l => l.id), leadsL.map(l => l.id))
  assert.deepEqual(leadsP, leadsL)

  assert.equal(await pg.countHiddenLeads(T, J), await lite.countHiddenLeads(T, J))
  assert.deepEqual(await pg.sequenceStatusByLead(T), await lite.sequenceStatusByLead(T))
  assert.deepEqual(await pg.enrichmentsForLeads(T, ['L1']), await lite.enrichmentsForLeads(T, ['L1']))
  assert.deepEqual(await pg.eventsForLeads(T, leadsL), await lite.eventsForLeads(T, leadsL))
  assert.deepEqual(await pg.leadPriorities(T, leadsL), await lite.leadPriorities(T, leadsL))
  const lookInput = leadsL.map(l => ({ id: l.id, signal: l.signal, industry: 'software', location: 'Toronto' }))
  assert.deepEqual(await pg.lookalikeSignals(T, lookInput), await lite.lookalikeSignals(T, lookInput))
})
