import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateOnboardingPolicy, activeOnboardingPolicy, optInOnboarding, withdrawOnboarding, enrollOnboarding, onboardingSendAllowed, purgeOnboardingAudit, ONBOARDING_POLICY_VERSION, ONBOARDING_AUDIT_RETAIN_S } from '../lib/outreach/onboarding-policy.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateLifecycle } from '../lib/outreach/lifecycle.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'

function setup() {
  const db = new Database(':memory:')
  migrateOnboardingPolicy(db); migrateLifecycle(db); migrateOutreach(db)
  return db
}
const converted = (db: Database.Database, email: string, kind = 'signup', activated: number | null = 100) =>
  db.prepare('INSERT INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES (?, ?, ?, ?, 100, ?)').run(`${kind}|${email}`, kind, email, 't1', activated)

test('opt-in is explicit and audited; withdrawal ends the policy; re-opt-in restarts it', () => {
  const db = setup()
  assert.equal(activeOnboardingPolicy(db, 't1'), null)
  optInOnboarding(db, 't1', 'user-1', 1000)
  assert.deepEqual(activeOnboardingPolicy(db, 't1'), { policy_version: ONBOARDING_POLICY_VERSION, opted_in_by: 'user-1', opted_in_at: 1000 })
  assert.equal(withdrawOnboarding(db, 't1', 'user-1', 2000), true)
  assert.equal(activeOnboardingPolicy(db, 't1'), null)
  assert.equal(withdrawOnboarding(db, 't1', 'user-1', 2001), false, 'already withdrawn')
  optInOnboarding(db, 't1', 'user-2', 3000)
  assert.deepEqual(activeOnboardingPolicy(db, 't1'), { policy_version: ONBOARDING_POLICY_VERSION, opted_in_by: 'user-2', opted_in_at: 3000 })
  const actions = (db.prepare('SELECT action FROM onboarding_audit WHERE tenant_id = ? ORDER BY created_at').all('t1') as { action: string }[]).map(r => r.action)
  assert.deepEqual(actions, ['opted_in', 'withdrawn', 'opted_in'])
})

test('enrollment requires an active policy and an ACTIVATED conversion; idempotent', () => {
  const db = setup()
  converted(db, 'jane@acme.com')
  assert.equal(enrollOnboarding(db, 't1', 'jane@acme.com', 1000), 'no_policy')
  optInOnboarding(db, 't1', 'user-1', 900)
  assert.equal(enrollOnboarding(db, 't1', 'nobody@example.com', 1000), 'not_customer', 'no conversion row at all')
  converted(db, 'pending@acme.com', 'signup', null)
  assert.equal(enrollOnboarding(db, 't1', 'pending@acme.com', 1000), 'not_customer', 'pending (unverified) conversion is not a customer')
  assert.equal(enrollOnboarding(db, 't1', ' Jane@Acme.com ', 1000), 'enrolled', 'normalized exact email')
  assert.equal(enrollOnboarding(db, 't1', 'jane@acme.com', 1001), 'already')
  assert.equal((db.prepare('SELECT count(*) AS n FROM onboarding_enrollments WHERE tenant_id = ?').get('t1') as { n: number }).n, 1)
  assert.equal((db.prepare("SELECT count(*) AS n FROM onboarding_audit WHERE tenant_id = 't1' AND action = 'enrolled'").get() as { n: number }).n, 1, 'one audited enrollment')
})

test('the send gate is the AND of policy + activated conversion + enrollment; withdrawal kills it', () => {
  const db = setup()
  converted(db, 'jane@acme.com')
  optInOnboarding(db, 't1', 'user-1', 900)
  assert.equal(onboardingSendAllowed(db, 't1', 'jane@acme.com'), false, 'not enrolled yet')
  enrollOnboarding(db, 't1', 'jane@acme.com', 1000)
  assert.equal(onboardingSendAllowed(db, 't1', 'jane@acme.com'), true)
  assert.equal(onboardingSendAllowed(db, 't1', 'jane2@acme.com'), false, 'unrelated same-domain address is not enrolled')
  assert.equal(onboardingSendAllowed(db, 't2', 'jane@acme.com'), false, 'tenant isolation: t2 has no policy')
  withdrawOnboarding(db, 't1', 'user-1', 2000)
  assert.equal(onboardingSendAllowed(db, 't1', 'jane@acme.com'), false, 'withdrawn policy refuses even an enrolled customer')
})

test('an unrelated same-name signup enrolls nothing and gates nothing', () => {
  const db = setup()
  optInOnboarding(db, 't1', 'user-1', 900)
  converted(db, 'other-jane@acme.com') // a DIFFERENT address that happens to share the display name
  assert.equal(enrollOnboarding(db, 't1', 'jane@acme.com', 1000), 'not_customer', 'exact-email identity: same name is not the same person')
  assert.equal(onboardingSendAllowed(db, 't1', 'jane@acme.com'), false)
})

test('onboarding_audit is append-only consent evidence: update and delete refused', () => {
  const db = setup()
  optInOnboarding(db, 't1', 'user-1', 1000)
  assert.throws(() => db.prepare("UPDATE onboarding_audit SET action = 'withdrawn'").run(), /append-only/)
  assert.throws(() => db.prepare('DELETE FROM onboarding_audit').run(), /append-only/)
  assert.equal((db.prepare('SELECT count(*) AS n FROM onboarding_audit').get() as { n: number }).n, 1, 'the evidence row survived both attempts')
})

test('policy versions reconsent, never grandfather: an older-version opt-in is recorded but inactive', () => {
  const db = setup()
  optInOnboarding(db, 't1', 'user-1', 1000)
  converted(db, 'jane@acme.com')
  enrollOnboarding(db, 't1', 'jane@acme.com', 1001)
  assert.equal(onboardingSendAllowed(db, 't1', 'jane@acme.com'), true)
  // simulate the next policy version shipping: the stored opt-in predates it
  db.prepare("UPDATE onboarding_policies SET policy_version = '1999-01-01'").run()
  assert.equal(activeOnboardingPolicy(db, 't1'), null, 'old-version opt-in is not active')
  assert.equal(enrollOnboarding(db, 't1', 'jane@acme.com', 1002), 'no_policy')
  assert.equal(onboardingSendAllowed(db, 't1', 'jane@acme.com'), false, 'the gate fails closed until re-opt-in')
})

test('audit evidence is content-free at the source: no email or actor detail is stored', () => {
  const db = setup()
  converted(db, 'jane@acme.com')
  optInOnboarding(db, 't1', 'user-1', 900)
  enrollOnboarding(db, 't1', 'jane@acme.com', 1000)
  withdrawOnboarding(db, 't1', 'user-1', 2000)
  const rows = db.prepare('SELECT action, detail FROM onboarding_audit').all() as { action: string; detail: string | null }[]
  assert.deepEqual(rows.map(r => r.action), ['opted_in', 'enrolled', 'withdrawn'])
  for (const r of rows) { assert.ok(!String(r.detail ?? '').includes('@'), `detail holds no email: ${r.detail}`); assert.ok(!String(r.detail ?? '').includes('user-1'), `detail holds no actor: ${r.detail}`) }
})

test('marketing suppression stays separate: nothing here writes suppressions', () => {
  const db = setup()
  converted(db, 'jane@acme.com')
  optInOnboarding(db, 't1', 'user-1', 900)
  enrollOnboarding(db, 't1', 'jane@acme.com', 1000)
  withdrawOnboarding(db, 't1', 'user-1', 2000)
  assert.equal((db.prepare('SELECT count(*) AS n FROM suppressions').get() as { n: number }).n, 0)
})

test('retention purge: only rows of tenants whose erasure completed over 2 years ago, and only inside the gated transaction', async () => {
  const DAY = 24 * 60 * 60
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  try {
    optInOnboarding(raw, 't-live', 'user-1', 1000)
    optInOnboarding(raw, 't-recent', 'user-1', 1000)
    optInOnboarding(raw, 't-old', 'user-1', 1000)
    optInOnboarding(raw, 't-mid', 'user-1', 1000)
    const now = 1000 + 800 * DAY
    const tomb = "INSERT INTO tenant_tombstones (deleted_tenant, requested_at, requested_by, state, policy, completed_at) VALUES (?, ?, 'test', 'completed', '{}', ?)"
    raw.prepare(tomb).run('t-recent', now - 200 * DAY, now - 100 * DAY)
    raw.prepare(tomb).run('t-old', now - 740 * DAY, now - 731 * DAY)
    // an erasure that never completed is not "after account deletion"
    raw.prepare("INSERT INTO tenant_tombstones (deleted_tenant, requested_at, requested_by, state, policy) VALUES ('t-mid', ?, 'test', 'erased', '{}')").run(now - 740 * DAY)

    assert.equal(await purgeOnboardingAudit(db, { now }), 1, 'only the tenant erased more than 730 days ago')
    const left = raw.prepare('SELECT tenant_id FROM onboarding_audit ORDER BY tenant_id').all() as { tenant_id: string }[]
    assert.deepEqual(left.map(r => r.tenant_id), ['t-live', 't-mid', 't-recent'], 'live, mid-deletion and recently erased tenants keep their proof')
    assert.equal((raw.prepare('SELECT count(*) AS n FROM onboarding_audit_purge_gate').get() as { n: number }).n, 0, 'the gate row never survives the purge transaction')
    assert.equal(await purgeOnboardingAudit(db, { now }), 0, 'idempotent: nothing left to purge')
    assert.throws(() => raw.prepare('DELETE FROM onboarding_audit').run(), /append-only/, 'ungated delete still refused')
  } finally { await db.close() }
})
