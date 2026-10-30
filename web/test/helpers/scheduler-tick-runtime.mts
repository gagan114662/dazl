// The real tick route (app/api/internal/tick/route.ts) on a synthetic two-tenant store, run by test/scheduler-tick.test.ts
// through the tenant-route loader. Staging mode: Gmail is the stub, so nothing is sent or fetched (network fence).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { startOAuth } from '../../lib/gmail/oauth.ts'
import { acceptReadConsent } from '../../lib/outreach/replies.ts'
import { CONSENT_VERSION } from '../../lib/outreach/autopilot.ts'
import { saveSettings } from '../../lib/outreach/service.ts'
import { schedulerHealth, schedulerHealthResponse, startRun, tenantFreshness, BLOCKED_AFTER_FAILURES, STALE_AFTER_S } from '../../lib/ops/scheduler-runs.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'
import { GET as sequences } from '../../app/api/outreach/sequences/route.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = (await import('node:crypto')).randomBytes(32).toString('base64')
process.env.AUTOPILOT_ENABLED = '1' // the operator switch, in this process only: with it off every follow-up run is a refusal
const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const A = 'tenant-a-stalled', B = 'tenant-b-healthy'
for (const t of [A, B]) {
  db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', ?)").run(t, `${t}@example.test`, `${t} business`)
  // autopilot and follow-ups on, with a sender identity and the current consent, as enable() and setFollowups() leave
  // them (enable() itself refuses a tenant whose mailbox is not connected, which is A's whole point)
  saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  db.prepare('INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, consent_at, followups_enabled) VALUES (?, 1, 0, ?, ?, 1)').run(t, CONSENT_VERSION, Math.floor(Date.now() / 1000))
}
// B can read replies (stub Gmail + read consent); A has no mailbox connected, so its reply sync fails every tick
startOAuth(db, B, { env: { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test' } as never }); acceptReadConsent(db, B)
const call = async (secret?: string) => tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: secret ? { authorization: `Bearer ${secret}` } : {} }))
const runs = () => db.prepare('SELECT status, lease_generation, tenants_attempted, tenants_failed, finished_at FROM scheduler_runs ORDER BY started_at, rowid').all() as { status: string; lease_generation: number; tenants_attempted: number; tenants_failed: number; finished_at: number | null }[]
const now = () => Math.floor(Date.now() / 1000)

test('tick heartbeats: cron off, a stalled tenant, a crashed tick, recovery; no tenant detail in the operator view', async () => {
  // cron disabled (no secret configured): the route does not exist and nothing is recorded; health says never ran
  delete process.env.AUTOPILOT_TICK_SECRET
  assert.equal((await call('x')).status, 404)
  assert.equal(runs().length, 0)
  assert.equal((await schedulerHealth(db)).operational.state, 'never_ran')
  process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'

  // one tick: recorded with its lease generation; A's reply sync failed, B's work succeeded
  const r1 = await (await call('test-tick-secret')).json()
  assert.equal(r1.ok, true); assert.equal(r1.tenant_failures, 1)
  assert.deepEqual(runs().map(r => [r.status, r.lease_generation, r.tenants_attempted, r.tenants_failed]), [['partial', 1, 2, 1]])
  const p = (t: string, k: string) => db.prepare('SELECT * FROM scheduler_progress WHERE tenant_id = ? AND kind = ?').get(t, k) as { last_success_at: number | null; consecutive_failures: number; last_error: string | null } | undefined
  assert.equal(p(A, 'reply_sync')?.consecutive_failures, 1); assert.match(p(A, 'reply_sync')!.last_error!, /reading_not_enabled/)
  assert.ok(p(B, 'reply_sync')?.last_success_at); assert.ok(p(B, 'followups')?.last_success_at)

  // A stalls: after BLOCKED_AFTER_FAILURES ticks it is blocked; B stays healthy
  for (let i = 1; i < BLOCKED_AFTER_FAILURES; i++) await call('test-tick-secret')
  assert.equal((await tenantFreshness(db, A)).state, 'blocked'); assert.deepEqual((await tenantFreshness(db, A)).reasons, ['reply_sync_failing'])
  assert.equal((await tenantFreshness(db, B)).state, 'healthy')
  const h = await schedulerHealthResponse(db); const body = await h.text()
  assert.equal(h.status, 503); assert.match(body, /1 tenant\(s\) blocked/)
  for (const leak of [A, B, 'reading_not_enabled', 'business']) assert.ok(!body.includes(leak), `operator view leaks ${leak}`)

  // each tenant's own view: only its rows
  setUser({ id: B, business_name: '' })
  const seqB = await (await sequences(new NextRequest('http://localhost/api/outreach/sequences'))).text()
  assert.ok(JSON.parse(seqB).freshness.state === 'healthy' && !seqB.includes(A) && !seqB.includes('reading_not_enabled'))
  setUser({ id: A, business_name: '' })
  assert.equal(JSON.parse(await (await sequences(new NextRequest('http://localhost/api/outreach/sequences'))).text()).freshness.state, 'blocked')

  // cron stops: with no new tick, the scheduler reads stale once STALE_AFTER_S passes
  assert.equal((await schedulerHealth(db, now() + STALE_AFTER_S + 60)).operational.state, 'stale')

  // a tick crashes: its process died inside the run (row left running, lease left behind and since expired)
  db.prepare("UPDATE app_leases SET expires_at = 0 WHERE name = 'internal-tick'").run()
  const g = (db.prepare("SELECT generation FROM app_leases WHERE name = 'internal-tick'").get() as { generation: number } | undefined)?.generation ?? 0
  // the earlier ticks happened an hour before; the dead one started 40 minutes ago and is the newest run
  db.prepare('UPDATE scheduler_runs SET started_at = started_at - 3600, finished_at = finished_at - 3600').run()
  db.prepare('UPDATE scheduler_progress SET last_attempt_at = last_attempt_at - 3600, last_success_at = last_success_at - 3600').run()
  await startRun(db, { owner: 'dead-process', generation: g }, now() - 40 * 60)
  assert.equal((await schedulerHealth(db)).operational.state, 'crashed')
  assert.equal((await schedulerHealthResponse(db)).status, 503)

  // recovery: A's mailbox is connected; the next tick takes over the expired lease at a new generation and both are healthy
  startOAuth(db, A, { env: { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test' } as never }); acceptReadConsent(db, A)
  const r2 = await (await call('test-tick-secret')).json()
  assert.equal(r2.ok, true); assert.equal(r2.tenant_failures, 0)
  const last = runs().at(-1)!
  assert.equal(last.status, 'ok'); assert.ok(last.lease_generation > g, 'a new lease generation after the takeover')
  assert.equal((await schedulerHealth(db)).operational.state, 'fresh')
  assert.equal((await tenantFreshness(db, A)).state, 'healthy'); assert.equal(p(A, 'reply_sync')?.consecutive_failures, 0)
  assert.equal((await schedulerHealthResponse(db)).status, 200)
})
