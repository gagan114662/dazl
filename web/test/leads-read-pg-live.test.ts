import test from 'node:test'
import type { SpendHold } from '../lib/scan/spend-cap.ts'
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
  try {
    await client.connect()
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

// #594 reaper race, REAL Postgres (not pg-mem): a second connection commits a reservation BETWEEN the reaper's two statements.
// READ COMMITTED gives statement 2 a fresh snapshot, so the NOT IN sees the new row and never re-queues a possibly-billed job;
// the next read finalizes it accounting_uncertain. Also pins bounded finalization for a dead earlier attempt's unsettled call.
test('real Postgres reaper: a reservation committed between the two statements is never re-queued (two connections)', { skip: !PG_ADMIN && 'DAZL_PG_ADMIN not set' }, async () => {
  const { Client } = await import('pg')
  const { provisionRehearsalDb, assertRehearsalTarget, dropRehearsalDb } = await import('../scripts/pg-migrate/guard.ts')
  const { readFileSync } = await import('node:fs')
  const prov = await provisionRehearsalDb(PG_ADMIN as string, 'rhz-' + Math.random().toString(36).slice(2))
  const a = new Client({ connectionString: prov.url }); const b = new Client({ connectionString: prov.url })
  try {
    await a.connect(); await b.connect()
    await assertRehearsalTarget(a, prov.token)
    await a.query(readFileSync(FULL_SCHEMA, 'utf8'))
    await assertRehearsalTarget(a, prov.token)
    const old = Math.floor(Date.now() / 1000) - 100000
    const job = (id: string, attempts = 1) => a.query("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, attempts, claimed_at) VALUES ($1, 'u1', 'running', 'B', 'i', 'l', $2, $3, $2)", [id, old, attempts])
    const reserve = (id: string, attempt: number) => b.query("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ($1, 'u1', $2, $3, 'search', 0.05, 'reserved', $4)", ['c-' + id, id, attempt, old])
    await job('jA'); await reserve('jA', 1)    // reserved before the reaper runs
    await job('jB')                            // nothing reserved: ordinary requeue
    await job('jC')                            // its reservation is committed by connection B between the two statements
    await job('jD', 2); await reserve('jD', 1) // a dead earlier attempt's unsettled call: bounded finalization, never stuck 'running'
    let injected = false
    const wrapped = { query: async (t: string, p?: unknown[]) => { const r = await a.query(t, p as never); if (!injected && t.includes("'accounting_uncertain'")) { injected = true; await reserve('jC', 1) } return r } }
    const pg = pgLeadsRead(wrapped as never)
    const st = async (id: string) => (await a.query('SELECT status, error FROM scan_jobs WHERE id = $1', [id])).rows[0] as { status: string; error: string | null }
    await pg.getJob('u1', 'jA'); await pg.getJob('u1', 'jB'); await pg.getJob('u1', 'jC'); await pg.getJob('u1', 'jD')
    assert.deepEqual(await st('jA'), { status: 'failed', error: 'accounting_uncertain' })
    assert.equal((await st('jB')).status, 'pending')
    assert.notEqual((await st('jC')).status, 'pending', 'a job reserved between the statements is never re-queued')
    assert.deepEqual(await st('jD'), { status: 'failed', error: 'accounting_uncertain' }, "an earlier attempt's unsettled call finalizes uncertain, never stuck running")
    await pg.getJob('u1', 'jC')
    assert.deepEqual(await st('jC'), { status: 'failed', error: 'accounting_uncertain' }, 'the next read finalizes it uncertain')
  } finally {
    try { await a.end() } catch { /* never connected */ }
    try { await b.end() } catch { /* never connected */ }
    await dropRehearsalDb(PG_ADMIN as string, prov.dbName, prov.role)
  }
})

// #594 reaper race, REAL Postgres: the reserve transaction is still OPEN while the reaper's statement 2 runs. The reserve
// runs through the PRODUCTION reserveScanSpend (lib/scan/spend-cap.ts) on a real pgDb pool - nothing is mirrored, so the test
// cannot drift from the shipped SQL: dropping the claimed_at refresh from reserveScanSpend alone turns it red. Choreography:
// a BEFORE INSERT trigger on scan_spend_calls (test fixture only) takes a transaction-scoped advisory lock that connection C
// already holds, so the production reserve's tx stays open AFTER its UPDATE has taken the jE row lock; the reaper's statement
// 2 then waits on that row lock (proven via pg_locks, bounded - pg_stat_activity is masked for a non-superuser role). Releasing C lets the reserve commit; the reaper's EPQ
// re-check sees the new row version with the DB-clock-fresh claimed_at: the job is never re-queued pending with a reserved call.
test('real Postgres reaper: an open (uncommitted) reserve blocks statement 2 and is never re-queued after commit', { skip: !PG_ADMIN && 'DAZL_PG_ADMIN not set' }, async () => {
  const { Client } = await import('pg')
  const { provisionRehearsalDb, assertRehearsalTarget, dropRehearsalDb } = await import('../scripts/pg-migrate/guard.ts')
  const { readFileSync } = await import('node:fs')
  const { pgDb } = await import('../lib/db/client.ts')
  const { runWithScanSpend, reserveScanSpend } = await import('../lib/scan/spend-cap.ts')
  const prov = await provisionRehearsalDb(PG_ADMIN as string, 'rhz-' + Math.random().toString(36).slice(2))
  const a = new Client({ connectionString: prov.url }); const c = new Client({ connectionString: prov.url })
  const pool = pgDb({ connectionString: prov.url, max: 2 })
  try {
    await a.connect(); await c.connect()
    await assertRehearsalTarget(a, prov.token)
    await a.query(readFileSync(FULL_SCHEMA, 'utf8'))
    await assertRehearsalTarget(a, prov.token)
    const old = Math.floor(Date.now() / 1000) - 100000
    await a.query("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, attempts, claimed_at) VALUES ('jE', 'u1', 'running', 'B', 'i', 'l', $1, 1, $1)", [old])
    // Test-only trigger: the production reserve's INSERT into scan_spend_calls blocks until the advisory lock is free.
    await a.query("CREATE OR REPLACE FUNCTION block_spend_insert() RETURNS trigger AS $$ BEGIN PERFORM pg_advisory_xact_lock(424242); RETURN NEW; END $$ LANGUAGE plpgsql")
    await a.query('CREATE TRIGGER hold_spend_insert BEFORE INSERT ON scan_spend_calls FOR EACH ROW EXECUTE FUNCTION block_spend_insert()')
    await c.query('SELECT pg_advisory_lock(424242)') // session lock: the reserve's trigger blocks on the xact variant
    const nowS = () => Math.floor(Date.now() / 1000)
    let reserveDone = false; let reserveErr: unknown = null
    let hold: SpendHold | null = null as SpendHold | null
    const pRes = runWithScanSpend({ db: pool, jobId: 'jE', tenantId: 'u1', attempt: 1, cap: { ok: true, capCad: 100, fxCadPerUsd: 1.4, capUsd: 5 }, clock: nowS }, async () => { hold = await reserveScanSpend('tinyfish.search', () => 0.05) }).then(() => { reserveDone = true }, e => { reserveErr = e })
    // Barriers via pg_locks, exactly like test 4: pg_stat_activity's wait_event_type/query are MASKED for a
    // non-superuser role in this build (an activity-based poll was flaky here and can hang under CI's restricted role);
    // pg_locks is not redacted. Bounded 5s polls from connection C, never fixed sleeps, never from a blocked connection.
    const waitLock = async (sql: string, what: string) => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) { if ((await c.query(sql)).rows.length > 0) return; await new Promise(r2 => setTimeout(r2, 50)) }
      throw new Error(`${what} was not observed waiting within 5s (pg_locks barrier)`)
    }
    // Barrier 1: the production reserve must be open and blocked on the advisory lock (its INSERT's trigger waits on the
    // xact variant C holds; objid = 424242 is the single-bigint key) - its UPDATE already holds the jE row lock - BEFORE
    // the reaper starts (otherwise the reaper could finish statement 2 before the lock exists).
    await waitLock("SELECT 1 FROM pg_locks WHERE NOT granted AND locktype = 'advisory' AND objid = 424242", 'the production reserve')
    const pg = pgLeadsRead(a as never)
    let reaperDone = false
    const pReap = pg.getJob('u1', 'jE').then(() => { reaperDone = true })
    // Barrier 2: the reaper's statement 2 must be observed waiting on the open reserve's row lock (an ungranted tuple
    // lock on scan_jobs or a transactionid wait; from connection C - the reaper's own connection A is blocked inside
    // the statement, so its queries would queue).
    await waitLock("SELECT 1 FROM pg_locks WHERE NOT granted AND (relation = 'scan_jobs'::regclass OR locktype = 'transactionid')", "the reaper's statement 2")
    assert.equal(reaperDone, false, 'statement 2 has not completed while the reserve tx is open')
    await c.query('SELECT pg_advisory_unlock(424242)')
    await pRes
    if (reserveErr) throw reserveErr
    assert.equal(reserveDone, true, 'the production reserve completed after the release')
    await pReap
    const rows = (await a.query("SELECT status FROM scan_spend_calls WHERE scan_job_id = 'jE' AND status = 'reserved'")).rows
    assert.equal(rows.length, 1, 'the reserved (possibly billed) call row exists, written by the production reserve')
    const st = (await a.query("SELECT status, error FROM scan_jobs WHERE id = 'jE'")).rows[0] as { status: string; error: string | null }
    assert.equal(st.status, 'running', 'a job whose open reserve commits is never re-queued pending with a reserved call')
    // The reserve refreshed claimed_at from the DB clock (the owning attempt is alive and paying), so a later read still does
    // not reap it; finalization of a DEAD attempt's reserved row (stale claimed_at) is the any-attempt IN partition (jA/jD above).
    await pg.getJob('u1', 'jE')
    const st2 = (await a.query("SELECT status, error FROM scan_jobs WHERE id = 'jE'")).rows[0] as { status: string; error: string | null }
    assert.deepEqual(st2, { status: 'running', error: null }, 'a live attempt holding a reservation stays running, never pending-with-reserved')
    // Settle through the PRODUCTION hold (not discarded): the reserved row transitions once, the job stays running, and the
    // same-attempt settle refreshes claimed_at.
    assert.ok(hold, 'the production reserve returned a hold')
    await hold!.settle(0.04)
    const settled = (await a.query("SELECT status, actual_usd FROM scan_spend_calls WHERE scan_job_id = 'jE'")).rows[0] as { status: string; actual_usd: string }
    assert.deepEqual([settled.status, Number(settled.actual_usd)], ['settled', 0.04], 'the production settle moved the reservation to the reported cost')
    const st3 = (await a.query("SELECT status, claimed_at FROM scan_jobs WHERE id = 'jE'")).rows[0] as { status: string; claimed_at: string }
    assert.equal(st3.status, 'running')
    assert.ok(Number(st3.claimed_at) > old, 'the real settle refreshed claimed_at (same attempt, real transition)')
  } finally {
    try { await c.query('SELECT pg_advisory_unlock_all()') } catch { /* never connected */ }
    try { await a.end() } catch { /* never connected */ }
    try { await c.end() } catch { /* never connected */ }
    try { await pool.pool.end() } catch { /* never connected */ }
    await dropRehearsalDb(PG_ADMIN as string, prov.dbName, prov.role)
  }
})

test('real Postgres reserve: claimed_at is written by clock_timestamp AFTER the row-lock wait, never the pre-wait tx start', { skip: !PG_ADMIN && 'DAZL_PG_ADMIN not set' }, async () => {
  const { Client } = await import('pg')
  const { provisionRehearsalDb, assertRehearsalTarget, dropRehearsalDb } = await import('../scripts/pg-migrate/guard.ts')
  const { readFileSync } = await import('node:fs')
  const { pgDb } = await import('../lib/db/client.ts')
  const { runWithScanSpend, reserveScanSpend } = await import('../lib/scan/spend-cap.ts')
  const prov = await provisionRehearsalDb(PG_ADMIN as string, 'rhz-' + Math.random().toString(36).slice(2))
  const a = new Client({ connectionString: prov.url }); const c = new Client({ connectionString: prov.url })
  const pool = pgDb({ connectionString: prov.url, max: 2 })
  try {
    await a.connect(); await c.connect()
    await assertRehearsalTarget(a, prov.token)
    await a.query(readFileSync(FULL_SCHEMA, 'utf8'))
    await assertRehearsalTarget(a, prov.token)
    await a.query("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, attempts, claimed_at) VALUES ('jF', 'u1', 'running', 'B', 'i', 'l', 1, 1, 1)")
    // C holds the jF row lock; the production reserve's UPDATE blocks on it.
    await c.query('BEGIN')
    await c.query("UPDATE scan_jobs SET claimed_at = claimed_at WHERE id = 'jF'")
    let reserveErr: unknown = null
    const pRes = runWithScanSpend({ db: pool, jobId: 'jF', tenantId: 'u1', attempt: 1, cap: { ok: true, capCad: 100, fxCadPerUsd: 1.4, capUsd: 5 }, clock: () => Math.floor(Date.now() / 1000) }, () => reserveScanSpend('tinyfish.search', () => 0.05)).catch(e => { reserveErr = e })
    // Barrier: observe the reserve's UPDATE blocked. pg_locks is NOT redacted for a non-superuser
    // role, while pg_stat_activity wait_event_type/query ARE masked for other sessions in this
    // build (an activity-based poll was flaky here); an ungranted lock on scan_jobs or a
    // transactionid is the UPDATE waiting on C's row lock. Bounded 5s poll from c, no fixed sleep.
    const deadline = Date.now() + 5000
    let waiting = false
    while (Date.now() < deadline && !waiting) {
      const w = (await c.query("SELECT 1 FROM pg_locks WHERE NOT granted AND (relation = 'scan_jobs'::regclass OR locktype = 'transactionid')")).rows
      waiting = w.length > 0
      if (!waiting) await new Promise(r => setTimeout(r, 50))
    }
    assert.ok(waiting, 'the production reserve was observed blocked on the row lock via pg_locks (bounded 5s, no fixed sleep)')
    await new Promise(r => setTimeout(r, 2500)) // hold the lock well past the 1s epoch floor
    const rel = (await c.query('SELECT floor(extract(epoch from clock_timestamp()))::bigint AS t')).rows[0] as { t: string }
    await c.query('COMMIT')
    await pRes
    if (reserveErr) throw reserveErr
    const j = (await a.query("SELECT claimed_at FROM scan_jobs WHERE id = 'jF'")).rows[0] as { claimed_at: string }
    assert.ok(Number(j.claimed_at) >= Number(rel.t), `claimed_at (${j.claimed_at}) must be >= the post-wait release time (${rel.t}): now() (tx start) would be ${Number(rel.t) - 3}s or older - this is the freshness proof`)
  } finally {
    try { await c.query('ROLLBACK') } catch { /* never connected */ }
    try { await a.end() } catch { /* never connected */ }
    try { await c.end() } catch { /* never connected */ }
    try { await pool.pool.end() } catch { /* never connected */ }
    await dropRehearsalDb(PG_ADMIN as string, prov.dbName, prov.role)
  }
})

test('real Postgres baseline: the transition guard allows pending->running->failed (the cancel path) and RAISES on pending->failed', { skip: !PG_ADMIN && 'DAZL_PG_ADMIN not set' }, async () => {
  const { Client } = await import('pg')
  const { provisionRehearsalDb, assertRehearsalTarget, dropRehearsalDb } = await import('../scripts/pg-migrate/guard.ts')
  const { readFileSync } = await import('node:fs')
  const prov = await provisionRehearsalDb(PG_ADMIN as string, 'rhz-' + Math.random().toString(36).slice(2))
  const a = new Client({ connectionString: prov.url })
  try {
    await a.connect()
    await assertRehearsalTarget(a, prov.token)
    await a.query(readFileSync(FULL_SCHEMA, 'utf8'))
    await assertRehearsalTarget(a, prov.token)
    await a.query("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, attempts, claimed_at) VALUES ('jT1', 'u1', 'pending', 'B', 'i', 'l', 1, 0, NULL), ('jT2', 'u1', 'pending', 'B', 'i', 'l', 1, 0, NULL)")
    // The cancel path's exact transitions are legal on the PG baseline, as on SQLite.
    await a.query("UPDATE scan_jobs SET status = 'running', attempts = attempts + 1, claimed_at = 1 WHERE id = 'jT1' AND status = 'pending'")
    await a.query("UPDATE scan_jobs SET status = 'failed', error = 'cancelled', claimed_at = NULL WHERE id = 'jT1' AND status = 'running'")
    const j1 = (await a.query("SELECT status, error FROM scan_jobs WHERE id = 'jT1'")).rows[0] as { status: string; error: string }
    assert.deepEqual(j1, { status: 'failed', error: 'cancelled' }, 'pending->running->failed is legal on the PG baseline (the cancel path)')
    // A direct pending->failed jump is NOT legal: the two-step reaper and cancel must never rely on it.
    await assert.rejects(
      a.query("UPDATE scan_jobs SET status = 'failed', error = 'x' WHERE id = 'jT2' AND status = 'pending'"),
      /illegal scan job status transition/,
      'pending->failed is refused by the baseline transition guard',
    )
    const j2 = (await a.query("SELECT status FROM scan_jobs WHERE id = 'jT2'")).rows[0] as { status: string }
    assert.equal(j2.status, 'pending', 'the refused transition left the row pending')
  } finally {
    try { await a.end() } catch { /* never connected */ }
    await dropRehearsalDb(PG_ADMIN as string, prov.dbName, prov.role)
  }
})
