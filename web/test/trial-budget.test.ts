// Free-trial spend caps and abuse limits (lib/billing/trial-budget.ts), on SQLite and Postgres, with several tenants:
// no caps configured -> no trial; Google sign-in required; one trial per company domain (consumer mailboxes per
// account); per-user and global daily caps counted as the reserve while a scan runs and as its priced model calls once
// it ends; and, on Postgres, concurrent admissions from separate pools never overspend the global cap.
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, linkTrialReservation, trialCaps, utcDay } from '../lib/billing/trial-budget.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = 1_800_000_000
const caps = { DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_USER_DAILY_USD: '2.5', DAZL_TRIAL_GLOBAL_DAILY_USD: '4', DAZL_TRIAL_RESEARCH_RESERVE_USD: '0.5' }
const user = async (db: Db, id: string, email: string, google = true) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  if (google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
const admit = (db: Db, u: { id: string; email: string }, env: Record<string, string> = caps, now = NOW) => admitTrialScan(db, u, { env, now })
const job = async (db: Db, tenant: string, id: string, status: string) =>
  db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, ?, 'b', 'i', 'l', ?, ?)", [id, tenant, status, NOW])
// what the runner recorded as spent on the scan: every paid step it counted against the trial budget
const spent = (db: Db, jobId: string, usd: number) => db.run('UPDATE scan_jobs SET spend_reserved_usd = ? WHERE id = ?', [usd, jobId])

bothEngines('trial caps: fail closed without caps; Google sign-in required; one trial per company domain', async ({ db }) => {
  assert.equal(trialCaps({}), null)
  assert.equal(trialCaps({ ...caps, DAZL_TRIAL_GLOBAL_DAILY_USD: '0' }), null)
  assert.equal(trialCaps({ ...caps, DAZL_TRIAL_RESEARCH_RESERVE_USD: '' }), null, 'research must be priced')
  // with TinyFish on (dazl's key), its search and fetch prices must be set too; 0 is allowed (a free tier), unset is not
  const tf = { ...caps, TINYFISH_API_KEY: 'x' }
  assert.equal(trialCaps(tf), null)
  assert.equal(trialCaps({ ...tf, DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' })?.tinyfishFetchUsd, 0.002)
  const a = await user(db, 'a'.repeat(32), 'ann@acme.example')
  assert.deepEqual(await admit(db, a, {}), { ok: false, reason: 'not_configured' })
  const pw = await user(db, 'p'.repeat(32), 'pat@other.example', false)
  assert.deepEqual(await admit(db, pw, caps), { ok: false, reason: 'google_required' })
  // first account on acme.example gets a trial; a second acme.example account does not
  assert.equal((await admit(db, a)).ok, true)
  const a2 = await user(db, 'b'.repeat(32), 'bob@ACME.example')
  assert.deepEqual(await admit(db, a2), { ok: false, reason: 'domain_used' })
  // consumer mailboxes count per account: two gmail.com users each get one
  const g1 = await user(db, 'c'.repeat(32), 'one@gmail.com'), g2 = await user(db, 'd'.repeat(32), 'two@gmail.com')
  assert.equal((await admit(db, g1)).ok, true)
  assert.equal((await admit(db, g2)).ok, true)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM trial_reservations'))!.n), 3, 'refusals reserve nothing')
})

bothEngines('trial caps: per-user and global daily budget; running scans count their reserve, finished ones their priced calls', async ({ db }) => {
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com'), b = await user(db, 'b'.repeat(32), 'b@gmail.com'), c = await user(db, 'c'.repeat(32), 'c@gmail.com')
  // A: two scans (1 + 1 = 2 of 2.5); a third would reach 3 > 2.5
  const r1 = await admit(db, a), r2 = await admit(db, a)
  assert.ok(r1.ok && r2.ok)
  assert.deepEqual(await admit(db, a), { ok: false, reason: 'user_daily_cap' })
  // A's first scan finishes having recorded $0.15 spent (model calls, research, searches): A is at 1.15, room again
  await job(db, a.id, 'j'.repeat(24), 'done'); await linkTrialReservation(db, a.id, r1.reservation, 'j'.repeat(24))
  await spent(db, 'j'.repeat(24), 0.15)
  const r3 = await admit(db, a)
  assert.equal(r3.ok, true, 'a finished scan counts at what it recorded as spent')
  // global: A 2.15 + B 1 = 3.15; C's 1 would reach 4.15 > 4
  assert.equal((await admit(db, b)).ok, true)
  assert.deepEqual(await admit(db, c), { ok: false, reason: 'global_daily_cap' })
  // B's scan ends having spent its whole reserve: still no room for C
  await job(db, b.id, 'k'.repeat(24), 'done')
  const rb = (await db.get<{ id: string }>('SELECT id FROM trial_reservations WHERE tenant_id = ?', [b.id]))!.id
  await linkTrialReservation(db, b.id, rb, 'k'.repeat(24))
  await spent(db, 'k'.repeat(24), 1)
  assert.deepEqual(await admit(db, c), { ok: false, reason: 'global_daily_cap' })
  // a reservation links only to its own tenant's job: B cannot attach A's reservation to its scan
  await linkTrialReservation(db, b.id, r2.ok ? r2.reservation : '', 'k'.repeat(24))
  assert.equal((await db.get<{ job_id: string | null }>('SELECT job_id FROM trial_reservations WHERE id = ?', [r2.ok ? r2.reservation : '']))!.job_id, null)
  // a new UTC day starts from zero
  assert.equal((await admit(db, c, caps, NOW + 86400)).ok, true)
  assert.equal(utcDay(NOW + 86400), utcDay(NOW) + 1)
})

bothEngines('trial caps: concurrent admissions from separate pools never overspend the global cap', async ({ db, kind, url, schema }) => {
  if (kind !== 'pg') return // SQLite runs one transaction at a time in-process; the race is between Postgres connections
  const users = []
  for (let i = 0; i < 8; i++) users.push(await user(db, String(i).repeat(32), `u${i}@gmail.com`))
  const pools = users.map(() => pgDb({ connectionString: url!, searchPath: schema, max: 1 }))
  try {
    // global cap 4, reserve 1: of 8 simultaneous admissions exactly 4 may pass
    const rs = await Promise.all(users.map((u, i) => admit(pools[i], u)))
    assert.equal(rs.filter(r => r.ok).length, 4, JSON.stringify(rs))
    assert.ok(rs.filter(r => !r.ok).every(r => !r.ok && r.reason === 'global_daily_cap'))
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM trial_reservations'))!.n), 4)
  } finally { await Promise.all(pools.map(p => p.close())) }
})
