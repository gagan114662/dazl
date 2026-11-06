// #354: activateLifecycleForDb, the Db-layer twin the auth routes now call at the ownership boundary (verification,
// reset, Google sign-in, verified sign-in). Same result as the sync activateLifecycleFor on the same seed; fails
// closed on malformed addresses; idempotent under replays and concurrent calls; touches only the proven address.
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { activateLifecycleFor, activateLifecycleForDb, queuePendingLifecycleDb } from '../lib/outreach/lifecycle.ts'
import { ONBOARDING_POLICY_VERSION } from '../lib/outreach/onboarding-policy.ts'

const T = 'tenantT_seller', U = 'tenantU_other', NOW = 1_800_000_000
const EMAILS = ['pat@example.test', 'sam@example.test']

async function seed(db: Db): Promise<void> {
  for (const [t, e] of [[T, 'seller@example.test'], [U, 'other@example.test']]) await db.run("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, 'h', 's', ?)", [t, e, NOW])
  await db.run('INSERT INTO onboarding_policies (tenant_id, policy_version, opted_in_by, opted_in_at, withdrawn_at) VALUES (?, ?, ?, ?, NULL)', [T, ONBOARDING_POLICY_VERSION, T, NOW])
  for (const [j, tenant] of [['a1'.repeat(12), T], ['a2'.repeat(12), U]] as const) {
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, created_at) VALUES (?, ?, 'Co', 'x', 'y', 'q', ?)", [j, tenant, NOW])
    await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [j])
    for (const [i, email] of EMAILS.entries()) {
      const lead = `${tenant === T ? 'b' : 'c'}${i}`.repeat(12), m = `m-${tenant}-${i}`
      await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, contact, created_at) VALUES (?, ?, 'P', 'Co', 's', 'https://n.example/a', 80, ?, ?)", [lead, j, email, NOW])
      await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES (?, ?, ?, ?, 'hi', 'bodybodybodybodybodybody', 'draft', 'warmup_manual', 1800000100)", [m, tenant, lead, email])
      await db.run("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, ?, ?, ?, ?, 'active')", [`sq-${m}`, tenant, lead, m, email])
    }
  }
  for (const e of EMAILS) await queuePendingLifecycleDb(db, 'signup', e, null, NOW)
}

const state = async (db: Db) => ({
  events: await db.all('SELECT event_key, activated_at FROM lifecycle_events ORDER BY event_key'),
  messages: await db.all('SELECT id, status, error FROM outreach_messages ORDER BY id'),
  sequences: await db.all('SELECT id, status, stop_reason FROM sequences ORDER BY id'),
  enrollments: await db.all('SELECT tenant_id, email, source, enrolled_at FROM onboarding_enrollments ORDER BY tenant_id, email'),
  audit: await db.all("SELECT tenant_id, lead_id, action, detail, created_at FROM autopilot_audit WHERE action = 'sequence_stopped' ORDER BY tenant_id, lead_id"),
})

test('same rows as the sync activateLifecycleFor on the same seed (SQLite)', async () => {
  const a = new Database(':memory:'), b = new Database(':memory:')
  migrateAllSqlite(a); migrateAllSqlite(b)
  await seed(sqliteDb(a)); await seed(sqliteDb(b))
  const sync = activateLifecycleFor(a, 'pat@example.test', NOW + 1)
  const port = await activateLifecycleForDb(sqliteDb(b), 'pat@example.test', NOW + 1)
  assert.equal(port, sync)
  assert.deepEqual(await state(sqliteDb(b)), await state(sqliteDb(a)))
})

bothEngines('activates only the proven address, across tenants; its work stops once; the other address is untouched', async ({ db }) => {
  await seed(db)
  assert.equal(await activateLifecycleForDb(db, '  PAT@Example.TEST ', NOW + 1), 4, 'held touch + sequence, in both tenants')
  const s = await state(db)
  assert.deepEqual(s.events, [{ event_key: 'signup|pat@example.test', activated_at: NOW + 1 }, { event_key: 'signup|sam@example.test', activated_at: null }])
  assert.deepEqual(s.messages.map(m => `${m.id}:${m.status}`), [`m-${T}-0:skipped`, `m-${T}-1:draft`, `m-${U}-0:skipped`, `m-${U}-1:draft`])
  assert.deepEqual(s.enrollments, [{ tenant_id: T, email: 'pat@example.test', source: 'conversion:signup', enrolled_at: NOW + 1 }], 'only the opted-in tenant enrolls')
  // replay: nothing left to activate, nothing written again
  assert.equal(await activateLifecycleForDb(db, 'pat@example.test', NOW + 2), 0)
  assert.deepEqual(await state(db), s)
})

bothEngines('malformed or unknown addresses fail closed: 0 and nothing written', async ({ db }) => {
  await seed(db)
  const before = await state(db)
  for (const bad of ['', '   ', 'pat', 'no-at-sign.example', 'x'.repeat(100_000), '\u0000\uFFFD', '@', 'nobody@example.test', `${'p'.repeat(300)}@example.test`]) {
    assert.equal(await activateLifecycleForDb(db, bad, NOW + 1), 0, JSON.stringify(bad.slice(0, 20)))
  }
  for (const bad of [null, undefined, 42, ['pat@example.test'], { email: 'pat@example.test' }]) {
    await assert.rejects(activateLifecycleForDb(db, bad as unknown as string, NOW + 1), TypeError, 'a non-string never reaches SQL')
  }
  assert.deepEqual(await state(db), before)
})

bothEngines('two activations at once: the work stops once, one audit row per sequence', async ({ db }) => {
  await seed(db)
  const [x, y] = await Promise.all([activateLifecycleForDb(db, 'pat@example.test', NOW + 1), activateLifecycleForDb(db, 'pat@example.test', NOW + 1)])
  assert.equal(x + y, 4)
  const s = await state(db)
  assert.equal(s.audit.length, 2)
  assert.equal(s.enrollments.length, 1)
}, { pgMax: 3 })
