import { runWithScanSpend } from '../lib/scan/spend-cap.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { matchReadyApolloBuyer, planApolloBuyerMatches, type ApolloBuyerEvidence } from '../lib/enrich/apollo-ready-match.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { asDb, pgDb, type Db } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { deleteTenant } from '../lib/tenant/lifecycle.ts'
import { freshSchema, PG_URL, pgSkip } from './helpers/pg-test.ts'
import { planApolloReservations, reserveApolloLead } from '../lib/enrich/apollo-credit-ledger.ts'

test('#1910 Apollo refuses when off and admits only one lookup per lead across restarts and tenants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-ledger-'))
  const path = join(directory, 'test.db')
  let db = new Database(path)
  migrateAllSqlite(db)
  try {
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', {}, { id: 'scan', limit: 2 }), false)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '1.5' }, { id: 'scan', limit: 2 }), false)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '2' }, { id: 'scan', limit: 2 }), true)
    db.close()
    db = new Database(path)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '2' }, { id: 'scan', limit: 2 }), false)
    assert.equal(await reserveApolloLead(db, 'tenant-b', 'second', { APOLLO_CREDIT_CAP: '2' }, { id: 'scan', limit: 2 }), true)
    assert.equal(await reserveApolloLead(db, 'tenant-c', 'third', { APOLLO_CREDIT_CAP: '2' }, { id: 'scan', limit: 2 }), false)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('#1910 only an otherwise Ready buyer after a completed empty crawl reaches one Apollo people endpoint', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const calls: string[] = []
  const buyer: ApolloBuyerEvidence = { first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test', dayVerified: true,
    otherwiseReady: true, ownSiteRead: 'none_published' as const }
  const match = (leadId: string, evidence = buyer, cap = '1', tenantId = 'a', scanId = 'scan-a') =>
    matchReadyApolloBuyer(db, tenantId, leadId, evidence, {
      key: 'test-only', scanId, scanLimit: 1,
      env: { DAZL_ENV: 'staging', APOLLO_CREDIT_CAP: cap },
      fetchImpl: async input => {
        calls.push(String(input))
        return Response.json({ person: null })
      },
    })
  try {
    await match('held', { ...buyer, otherwiseReady: false })
    await match('undated', { ...buyer, dayVerified: false })
    await match('unresolved', { ...buyer, confirmedDomain: '' })
    await match('unread', { ...buyer, ownSiteRead: 'incomplete' })
    await match('already-found', { ...buyer, ownSiteRead: 'address_found' })
    assert.deepEqual(calls, [])
    await match('eligible')
    assert.equal(db.prepare("SELECT COUNT(*) FROM tenant_spend_pools WHERE period LIKE 'ch:%'").pluck().get(), 0)
    await match('eligible', buyer, '2')
    await match('at-cap', buyer, '1', 'b', 'scan-b')
    await match('same-scan', buyer, '2')
    assert.equal(calls.length, 1)
    assert.deepEqual(db.prepare('SELECT lead_id, scan_id, credit, result FROM apollo_credit_ledger').all(),
      [{ lead_id: 'eligible', scan_id: 'scan-a', credit: 1, result: 'empty' }])
    assert.deepEqual(calls, ['https://api.apollo.io/api/v1/people/match'])
  } finally {
    db.close()
  }
})

test('#1910 an unsent scan-spend refusal frees the pilot slot and workspace hold', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const buyer: ApolloBuyerEvidence = { first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
      dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published' }
    let calls = 0
    const lookup = () => matchReadyApolloBuyer(db, 'tenant', 'lead', buyer, {
      key: 'test-only', scanId: 'scan', scanLimit: 1,
      env: { DAZL_ENV: 'staging', APOLLO_CREDIT_CAP: '1' },
      fetchImpl: async () => { calls++; return Response.json({ person: null }) },
    })
    await assert.rejects(runWithScanSpend({
      db, jobId: 'scan', tenantId: 'tenant', attempt: 1, cap: { ok: false, reason: 'cap_config_invalid' }, accountLimits: null,
    }, lookup), /spend_refused:cap_config_invalid/)
    assert.equal(calls, 0)
    assert.equal(db.prepare('SELECT COUNT(*) FROM apollo_credit_ledger').pluck().get(), 0)
    assert.equal(db.prepare("SELECT COUNT(*) FROM tenant_spend_pools WHERE period LIKE 'ch:%'").pluck().get(), 0)
    await lookup()
    assert.equal(calls, 1)
  } finally { db.close() }
})

test('#1910 dry plan counts eligible new requests within both caps without reserving', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const env = { APOLLO_CREDIT_CAP: '3' }
  const scan = { id: 'planned-scan', limit: 2 }
  const buyer: ApolloBuyerEvidence = {
    first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published',
  }
  try {
    assert.equal(await reserveApolloLead(db, 'a', 'already', env, scan), true)
    const candidates = [
      { leadId: 'already', evidence: buyer },
      { leadId: 'held', evidence: { ...buyer, otherwiseReady: false } },
      { leadId: 'eligible', evidence: buyer },
      { leadId: 'eligible', evidence: buyer },
      { leadId: 'past-scan-cap', evidence: buyer },
    ]
    assert.deepEqual(await planApolloBuyerMatches(db, 'a', candidates, scan, env), ['eligible'])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apollo_credit_ledger').pluck().get(), 1)
    assert.deepEqual(await planApolloBuyerMatches(db, 'a', candidates, scan, {}), [])
    assert.equal(await reserveApolloLead(db, 'b', 'other', env, scan), true)
    assert.equal(await reserveApolloLead(db, 'b', 'third', env, scan), true)
    assert.deepEqual(await planApolloBuyerMatches(db, 'a', candidates, scan, env), [])
  } finally {
    db.close()
  }
})

test('#1910 a committed reservation blocks a second tenant while the first request is in flight', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-in-flight-'))
  const path = join(directory, 'ledger.db')
  const first = new Database(path)
  migrateAllSqlite(first)
  const second = new Database(path)
  const evidence: ApolloBuyerEvidence = {
    first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published',
  }
  const env = { DAZL_ENV: 'staging', APOLLO_CREDIT_CAP: '1' }
  let attempted = 0
  try {
    await matchReadyApolloBuyer(first, 'tenant-a', 'lead-a', evidence, {
      key: 'fixture-only', scanId: 'scan-a', scanLimit: 2, env,
      fetchImpl: async (_input, init) => {
        assert.equal(init?.redirect, 'error')
        attempted++
        assert.deepEqual(second.prepare('SELECT lead_id, credit, result FROM apollo_credit_ledger').all(),
          [{ lead_id: 'lead-a', credit: 1, result: 'reserved' }])
        assert.equal(await matchReadyApolloBuyer(second, 'tenant-b', 'lead-b', evidence, {
          key: 'fixture-only', scanId: 'scan-b', scanLimit: 2, env,
          fetchImpl: async () => {
            attempted++
            return Response.json({ person: null })
          },
        }), null)
        return Response.json({ person: null })
      },
    })
    assert.equal(attempted, 1)
    assert.deepEqual(second.prepare('SELECT lead_id, credit, result FROM apollo_credit_ledger').all(),
      [{ lead_id: 'lead-a', credit: 1, result: 'empty' }])
  } finally {
    first.close()
    second.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('#1910 an ambiguous transport error is logged and remains charged against the cap', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const evidence: ApolloBuyerEvidence = {
    first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published',
  }
  let attempted = 0
  const options = {
    key: 'fixture-only', scanLimit: 2, env: { DAZL_ENV: 'staging', APOLLO_CREDIT_CAP: '1' },
    fetchImpl: async () => {
      attempted++
      throw new Error('fixture transport disconnected after sending')
    },
  }
  try {
    await assert.rejects(matchReadyApolloBuyer(db, 'a', 'first', evidence, { ...options, scanId: 'scan-a' }),
      /fixture transport disconnected/)
    assert.equal(await matchReadyApolloBuyer(db, 'a', 'first', evidence, { ...options, scanId: 'scan-a' }), null)
    assert.equal(await matchReadyApolloBuyer(db, 'b', 'second', evidence, { ...options, scanId: 'scan-b' }), null)
    assert.equal(attempted, 1)
    assert.deepEqual(db.prepare('SELECT lead_id, credit, result FROM apollo_credit_ledger').all(),
      [{ lead_id: 'first', credit: 1, result: 'uncertain' }])
  } finally { db.close() }
})

test('#1910 a production or unset deployment cannot reserve or dispatch an Apollo pilot request', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const evidence: ApolloBuyerEvidence = {
    first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published',
  }
  try {
    for (const DAZL_ENV of ['production', undefined]) {
      assert.equal(await matchReadyApolloBuyer(db, 'tenant', 'lead', evidence, {
        key: 'fixture-only', scanId: 'scan', scanLimit: 1,
        env: { DAZL_ENV, APOLLO_CREDIT_CAP: '1' },
        fetchImpl: async () => { assert.fail('non-staging request reached transport') },
      }), null)
    }
    assert.equal(db.prepare('SELECT COUNT(*) FROM apollo_credit_ledger').pluck().get(), 0)
    assert.equal(db.prepare('SELECT COUNT(*) FROM tenant_spend_pools').pluck().get(), 0)
  } finally { db.close() }
})

test('#1910 the operator cannot configure a cap above the approved pilot ceiling', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const scan = { id: 'scan', limit: 1 }
  try {
    assert.equal(await reserveApolloLead(db, 'tenant', 'lead', { APOLLO_CREDIT_CAP: '51' }, scan), false)
    assert.equal(await reserveApolloLead(db, 'tenant', 'lead', { APOLLO_CREDIT_CAP: '50' }, scan), true)
  } finally { db.close() }
})

test('#1910 workspace credit refusal blocks the pilot before it dispatches or consumes a pilot slot', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const env = { DAZL_ENV: 'staging', APOLLO_CREDIT_CAP: '4', DAZL_APOLLO_CREDITS_DAY: '1' }
  const buyer: ApolloBuyerEvidence = { first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published' }
  const dispatched: string[] = []
  const match = (leadId: string) => matchReadyApolloBuyer(db, 'tenant', leadId, buyer, {
    key: 'fixture-only', scanId: 'scan', scanLimit: 4, env,
    fetchImpl: async () => { dispatched.push(leadId); return Response.json({ person: null }) },
  })
  try {
    await match('first')
    assert.equal(await match('refused'), null)
    assert.deepEqual(dispatched, ['first'])
    assert.deepEqual(db.prepare('SELECT lead_id FROM apollo_credit_ledger').pluck().all(), ['first'])
  } finally { db.close() }
})

const pilotCap = { APOLLO_CREDIT_CAP: '1' }
const pilotScan = { id: 'test-scan', limit: 2 }

async function reserveThenErase(db: Db) {
  assert.equal(await reserveApolloLead(db, 'tenant-a', 'lead-a', pilotCap, pilotScan), true)
  assert.equal(await reserveApolloLead(db, 'tenant-b', 'lead-b', pilotCap, pilotScan), false)
  const erased = await deleteTenant(db, 'tenant-a', { policy: { suppressions: 'erase' }, requestedBy: 'synthetic test' })
  assert.equal(erased.state, 'completed')
  assert.deepEqual(await db.all('SELECT tenant_id FROM apollo_credit_ledger WHERE tenant_id = ?', ['tenant-a']), [])
}

async function assertCapSurvives(db: Db) {
  assert.equal(await reserveApolloLead(db, 'tenant-b', 'lead-b', pilotCap, pilotScan), false)
  assert.deepEqual(await planApolloReservations(db, 'tenant-b', ['lead-b'], pilotCap, pilotScan), [])
}

async function assertAtomicReservations(one: Db, two: Db, rejectTally: () => void | Promise<unknown>) {
  const cap = { APOLLO_CREDIT_CAP: '2' }
  const admit = (db: Db, tenant: string) => reserveApolloLead(db, tenant, 'shared-lead', cap, pilotScan)
  const results = await Promise.all([admit(one, 'tenant-b'), admit(two, 'tenant-c')])
  assert.equal(results.filter(Boolean).length, 1)
  const winner = results[0] ? 'tenant-b' : 'tenant-c'
  const extended = { APOLLO_CREDIT_CAP: '3' }
  assert.equal(await reserveApolloLead(one, winner, 'shared-lead', extended, pilotScan), false)
  assert.equal(Number((await one.get<{ used: number }>('SELECT used FROM apollo_credit_total'))?.used), 2)
  await rejectTally()
  assert.equal(await reserveApolloLead(two, 'tenant-d', 'other-lead', extended, pilotScan), false)
  assert.deepEqual(await two.all('SELECT lead_id FROM apollo_credit_ledger WHERE tenant_id = ?', ['tenant-d']), [])
  assert.equal(Number((await two.get<{ used: number }>('SELECT used FROM apollo_credit_total'))?.used), 2)
}

test('#1910 SQLite lifetime cap survives tenant deletion and reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apollo-erasure-'))
  const path = join(dir, 'pilot.sqlite')
  let db = new Database(path)
  try {
    migrateAllSqlite(db)
    await reserveThenErase(asDb(db))
    db.close()
    db = new Database(path)
    migrateAllSqlite(db)
    await assertCapSurvives(asDb(db))
    const second = new Database(path)
    try {
      await assertAtomicReservations(asDb(db), asDb(second), () => {
        db.exec("CREATE TRIGGER reject_pilot_tally BEFORE UPDATE ON apollo_credit_total BEGIN SELECT RAISE(ABORT, 'fixture'); END")
      })
    } finally { second.close() }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1910 PostgreSQL lifetime cap survives tenant deletion and reconnecting', { skip: pgSkip }, async () => {
  const schema = await freshSchema()
  const options = { connectionString: PG_URL!, searchPath: schema.schema }
  let db = pgDb(options)
  try {
    await runPgMigrations(db.pool)
    await reserveThenErase(db)
    await db.pool.end()
    db = pgDb(options)
    await assertCapSurvives(db)
    const second = pgDb(options)
    try {
      await assertAtomicReservations(db, second, () =>
        db.pool.query('ALTER TABLE apollo_credit_total ADD CHECK (used <= 2)'))
    } finally { await second.pool.end() }
  } finally {
    await db.pool.end()
    await schema.drop()
  }
})

test('#1910 SQLite upgrade fails closed when a legacy ledger may have lost receipts', async () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE apollo_credit_ledger (tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      scan_id TEXT NOT NULL, credit INTEGER NOT NULL DEFAULT 1, result TEXT NOT NULL DEFAULT 'reserved',
      PRIMARY KEY (tenant_id, lead_id))`)
    migrateAllSqlite(db)
    await assertCapSurvives(asDb(db))
  } finally { db.close() }
})

test('#1910 PostgreSQL upgrade fails closed when a legacy ledger may have lost receipts', { skip: pgSkip }, async () => {
  const schema = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: schema.schema })
  try {
    await db.pool.query(`CREATE TABLE apollo_credit_ledger (tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      scan_id TEXT NOT NULL, credit BIGINT NOT NULL DEFAULT 1, result TEXT NOT NULL DEFAULT 'reserved',
      PRIMARY KEY (tenant_id, lead_id))`)
    await runPgMigrations(db.pool)
    await assertCapSurvives(db)
  } finally {
    await db.pool.end()
    await schema.drop()
  }
})
