// The real POST /api/scan handler for a keyless account on dazl's free trial (test/trial-attempts-route.test.ts):
// three admitted trial scans per account that can cost dazl money, paid failures and cancellations included. Each scan
// is then made to end as the runner would leave it (failed after a paid step: spend reserved, attempt settled) and the
// fourth request is refused - by the free-scans count and, independently, by admission under its lock. A scan that
// failed before any cost gives its slot back. In-memory SQLite, every migration; network fenced; runner never started.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { admitTrialScan, settleTrialReservation } from '../../lib/billing/trial-budget.ts'
import { trialStatus } from '../../lib/scan/trial.ts'
import { POST } from '../../app/api/scan/route.ts'

Object.assign(process.env, { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.01', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.01' })
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
const Q = 'Independent dental practices hiring a receptionist in New York'
let n = 0
function account(email: string) {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
  const id = `trial${++n}`.padEnd(32, '0')
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'Acme', 'x', 'y')").run(id, email)
  db.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)").run(`sub-${id}`, id)
  setUser({ id, business_name: 'Acme', email } as never)
  return { db, id }
}
const post = (ip: string) => POST(new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': ip }, body: JSON.stringify({ query: Q }) }))
// how the runner leaves a trial scan that ended: its attempt ran, reserved `spent` on paid steps, ended, and settled
const end = async (db: Database.Database, job: string, status: 'failed' | 'done', error: string | null, spent: number) => {
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ? AND status = 'pending'").run(job) // claimed
  db.prepare('UPDATE scan_jobs SET status = ?, error = ?, spend_reserved_usd = ?, finished_at = 1 WHERE id = ?').run(status, error, spent, job)
  await settleTrialReservation(sqliteDb(db), job, 1)
}
const start = async (ip: string) => { const r = await post(ip); const b = await r.json() as { job_id?: string; error?: string; reason?: string }; return { status: r.status, ...b } }

test('three paid trial failures use the three attempts: the fourth request is refused, by the count and by admission', async () => {
  const { db, id } = account('pat@gmail.com')
  for (let i = 0; i < 3; i++) {
    const r = await start(`10.0.0.${i + 1}`)
    assert.equal(r.status, 202, JSON.stringify(r))
    assert.equal((db.prepare('SELECT funded_by FROM scan_jobs WHERE id = ?').get(r.job_id) as { funded_by: string }).funded_by, 'trial')
    // each fails after a paid step (a provider error after its first model call): $0.02 reserved
    await end(db, r.job_id!, 'failed', 'provider_error', 0.02)
  }
  // only $0.06 of the $1 account total is spent: it is the attempts, not the money, that run out
  const fourth = await start('10.0.0.9')
  assert.equal(fourth.status, 402, JSON.stringify(fourth))
  assert.equal(fourth.error, 'trial_exhausted')
  assert.equal(trialStatus(db, id, '10.0.0.9').remaining, 0)
  // admission refuses on its own too (the count it keeps under its lock), however the first check is reached
  assert.deepEqual(await admitTrialScan(sqliteDb(db), { id, email: 'pat@gmail.com' }), { ok: false, reason: 'attempts_cap' })
  assert.equal((db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?").get(id) as { n: number }).n, 3, 'no fourth scan queued')
})

test('a cancelled trial scan that reserved nothing still uses its attempt; a scan that failed before any cost gives it back', async () => {
  const { db, id } = account('sam@gmail.com')
  const a = await start('10.0.1.1'); await end(db, a.job_id!, 'failed', 'cancelled', 0)          // cancelled: kept
  const b = await start('10.0.1.2'); await end(db, b.job_id!, 'failed', 'provider_error', 0.01) // paid failure: kept
  const c = await start('10.0.1.3'); await end(db, c.job_id!, 'failed', 'trial_unavailable', 0) // failed before any cost: released
  assert.equal(trialStatus(db, id, '10.0.1.4').remaining, 1)
  const d = await start('10.0.1.4')
  assert.equal(d.status, 202, 'the released attempt is usable again')
  // d is running (not ended): it holds the third attempt
  const e = await start('10.0.1.5')
  assert.ok(e.status === 402 || e.status === 409, JSON.stringify(e)) // 409 while d is active; never a fourth paid attempt
  await end(db, d.job_id!, 'done', null, 0.05)
  const f = await start('10.0.1.6')
  assert.equal(f.status, 402, JSON.stringify(f))
  assert.deepEqual(await admitTrialScan(sqliteDb(db), { id, email: 'sam@gmail.com' }), { ok: false, reason: 'attempts_cap' })
})
