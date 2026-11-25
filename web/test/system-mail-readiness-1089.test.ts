// #1089 (code half): readiness must be able to SEE account mail piling up unsent. The settings checks
// (lib/ops/launch-checks.ts) say whether SYSTEM_MAIL_* is configured; this covers the other half — the
// stored outbox itself (lib/system-mail.ts outboxReadiness), reported through readiness as checks.outbox.
// A stored row is normal for seconds (the tick reaps at 24 h); a row older than OUTBOX_STALE_S means mail
// is being written to the outbox instead of sent, or nothing is reaping — the prod failure this issue is
// about (rows sat for weeks, each holding a live link). Counts and ages only: never a recipient or body.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { loadMigrations } from '../lib/db/migrate-pg.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { OUTBOX_STALE_S, outboxReadiness } from '../lib/system-mail.ts'
import { readiness, resetLaunchReport } from '../lib/ops/health.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = 1_800_000_000
let seedN = 0
const seed = async (db: Parameters<typeof outboxReadiness>[0], ages: number[], now = NOW) => {
  for (const age of ages)
    await db.run('INSERT INTO system_mail_outbox (id, user_id, to_email, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [`row${seedN++}`, 'u1', 'someone@example.test', 'Confirm your email', 'a link', now - age])
}

bothEngines('outbox readiness: empty is ok, fresh is ok with its age, older than the stale limit is not', async ({ db }) => {
  assert.deepEqual(await outboxReadiness(db, NOW), { ok: true, stored: 0, oldest_age_s: null })
  await seed(db, [40, 120])
  assert.deepEqual(await outboxReadiness(db, NOW), { ok: true, stored: 2, oldest_age_s: 120 }, 'the OLDEST row sets the age')
  await seed(db, [OUTBOX_STALE_S + 1])
  assert.deepEqual(await outboxReadiness(db, NOW), { ok: false, reason: 'stale', stored: 3, oldest_age_s: OUTBOX_STALE_S + 1 })
})

bothEngines('outbox readiness: a row exactly at the stale limit is not yet stale', async ({ db }) => {
  await seed(db, [OUTBOX_STALE_S])
  assert.deepEqual(await outboxReadiness(db, NOW), { ok: true, stored: 1, oldest_age_s: OUTBOX_STALE_S })
})

test('readiness reports checks.outbox and folds it into launch.ok; ok is gated only when launch is required', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const stale = { ok: false as const, reason: 'stale' as const, stored: 2, oldest_age_s: 900 }
  const fine = { ok: true as const, stored: 1, oldest_age_s: 12 }
  const base = { db: async () => db, sqlite: () => raw, migrations: () => loadMigrations().map(m => m.version), mail: () => ({ ok: true as const, port: 465, verified_s_ago: 0 }), deletion: () => ({ ok: true as const }) }
  try {
    resetLaunchReport()
    const unwired = await readiness({ ...base })
    assert.deepEqual(unwired.checks.outbox, { ok: true, skipped: 'not_wired' }, 'an unwired outbox reads like unwired mail/deletion')
    assert.equal(unwired.launch.ok, true)

    const withStale = await readiness({ ...base, outbox: async () => stale })
    assert.deepEqual(withStale.checks.outbox, stale)
    assert.equal(withStale.launch.ok, false, 'a stale outbox is not launch-ready even when mail and deletion pass')
    assert.equal(withStale.ok, true, 'reported, not gating, until the operator requires launch checks')

    const required = await readiness({ ...base, outbox: async () => stale, launchRequired: () => true })
    assert.equal(required.ok, false, 'with DAZL_READY_REQUIRES_LAUNCH the stale outbox gates readiness')
    assert.deepEqual(required.launch, { ok: false, required: true })

    const healthy = await readiness({ ...base, outbox: async () => fine, launchRequired: () => true })
    assert.equal(healthy.ok, true)
    assert.deepEqual(healthy.checks.outbox, fine)
  } finally { await db.close() }
})

test('readiness still answers when the outbox dependency rejects, and exposes no error detail (Ziggy)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const base = { db: async () => db, sqlite: () => raw, migrations: () => loadMigrations().map(m => m.version), mail: () => ({ ok: true as const, port: 465, verified_s_ago: 0 }), deletion: () => ({ ok: true as const }) }
  try {
    resetLaunchReport()
    const r = await readiness({ ...base, outbox: async () => { throw new Error('db acquisition failed: hunter2-internal-detail') } })
    assert.deepEqual(r.checks.outbox, { ok: false, reason: 'error' }, 'a rejecting outbox is a failed check, not a rejected readiness')
    assert.equal(JSON.stringify(r).includes('hunter2'), false, 'no error detail reaches the response')
    assert.equal(r.launch.ok, false)
  } finally { await db.close() }
})

test('readiness still answers when the outbox dependency never resolves (Ziggy)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const base = { db: async () => db, sqlite: () => raw, migrations: () => loadMigrations().map(m => m.version), mail: () => ({ ok: true as const, port: 465, verified_s_ago: 0 }), deletion: () => ({ ok: true as const }) }
  try {
    resetLaunchReport()
    const t0 = Date.now()
    const r = await readiness({ ...base, outbox: () => new Promise<never>(() => {}), timeoutMs: 25 })
    assert.ok(Date.now() - t0 < 1500, 'readiness answers within its budget instead of hanging on the outbox')
    assert.deepEqual(r.checks.outbox, { ok: false, reason: 'error' }, 'a stalled outbox is a failed check')
  } finally { await db.close() }
})

test('#1089 (Qodo) concurrent outbox reads share one in-flight query, cleared when it settles', async () => {
  let calls = 0
  let release: (v: { n: number; oldest: null }) => void = () => {}
  const gate = new Promise<{ n: number; oldest: null }>(res => { release = res })
  const fakeDb = { get: async () => { calls++; return gate } } as unknown as Parameters<typeof outboxReadiness>[0]
  const a = outboxReadiness(fakeDb, NOW)
  const b = outboxReadiness(fakeDb, NOW)
  assert.equal(calls, 1, 'the second concurrent probe joins the in-flight read instead of starting its own')
  release({ n: 0, oldest: null })
  assert.deepEqual(await a, { ok: true, stored: 0, oldest_age_s: null })
  assert.deepEqual(await b, { ok: true, stored: 0, oldest_age_s: null })
  await outboxReadiness(fakeDb, NOW)
  assert.equal(calls, 2, 'once settled, the next probe reads again')
})
