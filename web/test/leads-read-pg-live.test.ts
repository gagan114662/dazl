import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteLeadsRead } from '../lib/db/leads-read.ts'
import { pgLeadsRead } from '../lib/db/leads-read-pg.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'

// REAL Postgres contract run (not pg-mem). Skips unless DAZL_PG_ADMIN points at a
// loopback maintenance URL: the test provisions its own guarded, dedicated
// dazl_rehearse_* database (guard.ts) and loads the FULL translated schema
// (schema-full.generated.sql, BIGINT numerics) - this exercises the int8-as-string
// driver behavior that pg-mem masks. Seeds the same synthetic rows into SQLite and
// real pg and deep-equals all 8 LeadsReadDb methods.
const PG_ADMIN = process.env.DAZL_PG_ADMIN
if (process.env.DAZL_PG_ADMIN === '') process.env.DAZL_PG_ADMIN = undefined
const FULL_SCHEMA = new URL('../scripts/pg-migrate/schema-full.generated.sql', import.meta.url)

const T = 't1', J = 'job000000000000000000001'
const now = 1800000000

function seedSqlite(d: Database.Database) {
  d.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, query, icp_inferred) VALUES (?, ?, 'running', 'Biz', 'software', 'Toronto', ?, 'q', 1)").run(J, T, now - 100)
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

test('real Postgres implementation matches sqlite adapter on identical synthetic rows', { skip: !PG_ADMIN && 'DAZL_PG_ADMIN not set' }, async () => {
  const { Client } = await import('pg')
  const { provisionRehearsalDb, assertRehearsalTarget, dropRehearsalDb } = await import('../scripts/pg-migrate/guard.ts')
  const { readFileSync } = await import('node:fs')
  const prov = await provisionRehearsalDb(PG_ADMIN as string, 'rhz-' + Math.random().toString(36).slice(2))
  const client = new Client({ connectionString: prov.url })
  await client.connect()
  try {
    await assertRehearsalTarget(client, prov.token)
    await client.query(readFileSync(FULL_SCHEMA, 'utf8'))
    await assertRehearsalTarget(client, prov.token)
    const q = (t: string, p: unknown[]) => client.query(t, p)
    await q("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, query, icp_inferred) VALUES ($1, $2, 'running', 'Biz', 'software', 'Toronto', $3, 'q', 1)", [J, T, now - 100])
    const ins = "INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, created_at, fit, intent, action, company_domain) VALUES ($1, $2, '', $3, NULL, $4, 'https://example.com/jobs/1', 80, $5, $6, $7, $8, $9)"
    await q(ins, ['L1', J, 'Acme', 'Hiring sales operations manager', now - 90, 5, 4, 3, 'acme.com'])
    await q(ins, ['L2', J, 'Hidden Co', 'weak signal here', now - 80, 1, 1, 1, null])
    await q(ins, ['L3', J, 'Beta', 'Sales operations manager needed', now - 70, 4, 4, 4, null])
    await q(ins, ['L4', J, 'Gamma', 'CRM administrator and sales operations', now - 60, 4, 4, 4, null])
    await q(ins, ['L5', J, 'Delta', 'sales operations lead opening', now - 50, 4, 4, 4, null])
    await q("UPDATE scan_jobs SET status = 'done' WHERE id = $1", [J])
    await q("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, created_at) VALUES ('M1', $1, 'L1', 'a@b.c', 's', '01234567890123456789', 'sent', 1000, 999)", [T])
    await q("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status, created_at) VALUES ('S1', $1, 'L1', 'M1', 'a@b.c', 'active', 998)", [T])
    await q("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status, sent_at, created_at) VALUES ($1, 'S1', 2, 's2', '01234567890123456789', 'sent', 2000, 997)", [T])
    await q("INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES ($1, '[]')", [T])
    await q("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('E1', 'L1', $1, 'apollo', 'person', 'Ada', 'Head of Sales', 90, 'https://apollo.io/x', '2026-10-01', 3000)", [T])
    await q("INSERT INTO company_events (id, tenant_id, company_key, company_name, scope, lead_id, event_type, summary, detail, source_url, source_published_at, retrieved_at, first_seen_at, last_seen_at, confidence) VALUES ('V1', $1, 'acme.com', 'Acme', 'account', 'L1', 'funding_round', 'Raised', NULL, 'https://news.example/a', '2026-10-01', 4000, 3900, 4000, 80)", [T])

    const d = new Database(':memory:')
    migrateScan(d); migrateEvents(d); migrateOutreach(d); migrateSequences(d); migrateConnectors(d); migrateReplies(d)
    seedSqlite(d)
    const lite = sqliteLeadsRead(d)
    const pg = pgLeadsRead(client as never)

    assert.deepEqual(await pg.getJob(T, J), await lite.getJob(T, J))
    const leadsL = await lite.listLeads(T, J, 200, false) as { id: string; company_domain: string | null; signal: string; fit: number | null; intent: number | null; action: number | null }[]
    const leadsP = await pg.listLeads(T, J, 200, false) as typeof leadsL
    assert.deepEqual(leadsP, leadsL)
    assert.equal(await pg.countHiddenLeads(T, J), await lite.countHiddenLeads(T, J))
    assert.deepEqual(await pg.sequenceStatusByLead(T), await lite.sequenceStatusByLead(T))
    assert.deepEqual(await pg.enrichmentsForLeads(T, ['L1']), await lite.enrichmentsForLeads(T, ['L1']))
    assert.deepEqual(await pg.eventsForLeads(T, leadsL), await lite.eventsForLeads(T, leadsL))
    assert.deepEqual(await pg.leadPriorities(T, leadsL), await lite.leadPriorities(T, leadsL))
    const lookInput = leadsL.map(l => ({ id: l.id, signal: l.signal, industry: 'software', location: 'Toronto' }))
    assert.deepEqual(await pg.lookalikeSignals(T, lookInput), await lite.lookalikeSignals(T, lookInput))

    // pin the driver behavior the numeric policy depends on: int8 comes back as
    // STRING from the real driver (pg-mem returns numbers and masks this)
    const raw = await client.query('SELECT created_at FROM scan_jobs WHERE id = $1', [J])
    assert.equal(typeof (raw.rows[0] as { created_at: unknown }).created_at, 'string', 'pg driver must return BIGINT as string - if this changes, revisit the coercion policy')
  } finally {
    await client.end()
    await dropRehearsalDb(PG_ADMIN as string, prov.dbName, prov.role)
  }
})
