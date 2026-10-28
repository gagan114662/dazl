// Free-trial ceilings and abuse limits at admission (lib/billing/trial-budget.ts), on SQLite and Postgres, with the
// proposed numbers (not approved spend): $0.30 a scan, $1 per trial account in total, $10 a day globally. No ceiling
// configured -> no trial; Google sign-in required; one trial per company domain. The account ceiling holds across days;
// the global one per UTC day, including scans still running from the day before; a scan counts as its reserve while it
// runs and as what it recorded as spent once it ends. On Postgres, concurrent admissions from
// separate pools (separate workers or instances) never pass either ceiling. The per-scan ceiling inside the runner is
// test/trial-budget-scan.test.ts.
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, linkTrialReservation, trialCaps, utcDay } from '../lib/billing/trial-budget.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = 1_800_000_000
const DAY = utcDay(NOW)
const caps = { DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' }
const user = async (db: Db, id: string, email: string, google = true) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  if (google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
const uid = (n: number) => n.toString(16).padStart(32, '0')
const admit = (db: Db, u: { id: string; email: string }, now = NOW) => admitTrialScan(db, u, { env: caps, now })
// The scan an admission paid for, linked to its reservation, then ended: what the runner recorded as spent on it
let jobs = 0
const scan = async (db: Db, tenant: string, reservation: string, o: { status?: string; spent?: number; finishedAt?: number } = {}) => {
  const id = `job${String(++jobs).padStart(21, '0')}`
  await db.run('INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at, spend_reserved_usd, finished_at) VALUES (?, ?, \'b\', \'i\', \'l\', ?, ?, ?, ?)',
    [id, tenant, o.status ?? 'running', NOW, o.spent ?? 0, o.finishedAt ?? null])
  await linkTrialReservation(db, tenant, reservation, id)
  return id
}
const end = (db: Db, jobId: string, spent: number, finishedAt = NOW) => db.run("UPDATE scan_jobs SET status = 'done', spend_reserved_usd = ?, finished_at = ? WHERE id = ?", [spent, finishedAt, jobId])
const reservation = (r: Awaited<ReturnType<typeof admitTrialScan>>) => { assert.ok(r.ok, JSON.stringify(r)); return r.reservation }

bothEngines('trial ceilings: off without every ceiling and TinyFish priced; Google sign-in required; one trial per company domain', async ({ db }) => {
  assert.equal(trialCaps({}), null)
  assert.deepEqual(trialCaps(caps), { reserveUsd: 0.3, accountTotalUsd: 1, globalDailyUsd: 10, tinyfishSearchUsd: 0.004, tinyfishFetchUsd: 0.002 })
  for (const k of ['DAZL_TRIAL_SCAN_RESERVE_USD', 'DAZL_TRIAL_ACCOUNT_TOTAL_USD', 'DAZL_TRIAL_GLOBAL_DAILY_USD', 'DAZL_TRIAL_TINYFISH_SEARCH_USD', 'DAZL_TRIAL_TINYFISH_FETCH_USD', 'TINYFISH_API_KEY'])
    assert.equal(trialCaps({ ...caps, [k]: '' }), null, `${k} unset: no trial`)
  assert.equal(trialCaps({ ...caps, DAZL_TRIAL_GLOBAL_DAILY_USD: '0' }), null)
  assert.equal(trialCaps({ ...caps, TINYFISH_ENABLED: '0' }), null, "TinyFish is a trial's only web research")
  assert.equal(trialCaps({ ...caps, DAZL_TRIAL_USER_DAILY_USD: '1', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '' }), null, 'the old daily per-user cap is not an account ceiling')
  const a = await user(db, 'a'.repeat(32), 'ann@acme.example')
  assert.deepEqual(await admitTrialScan(db, a, { env: {}, now: NOW }), { ok: false, reason: 'not_configured' })
  const pw = await user(db, 'p'.repeat(32), 'pat@other.example', false)
  assert.deepEqual(await admit(db, pw), { ok: false, reason: 'google_required' })
  assert.equal((await admit(db, a)).ok, true)
  const a2 = await user(db, 'b'.repeat(32), 'bob@ACME.example')
  assert.deepEqual(await admit(db, a2), { ok: false, reason: 'domain_used' })
  const g1 = await user(db, 'c'.repeat(32), 'one@gmail.com'), g2 = await user(db, 'd'.repeat(32), 'two@gmail.com')
  assert.equal((await admit(db, g1)).ok, true)
  assert.equal((await admit(db, g2)).ok, true)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM trial_reservations'))!.n), 3, 'refusals reserve nothing')
})

bothEngines('trial ceilings: $1 per trial account in total holds across days; finished scans count what they spent', async ({ db }) => {
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com')
  // three running scans: 0.90 of 1.00; a fourth ($0.30) would reach 1.20
  const rs = [reservation(await admit(db, a)), reservation(await admit(db, a)), reservation(await admit(db, a))]
  assert.deepEqual(await admit(db, a), { ok: false, reason: 'account_total_cap' })
  // the same account on later days: still refused (a daily per-user cap would have reset here)
  for (const d of [1, 2, 30]) assert.deepEqual(await admit(db, a, NOW + d * 86400), { ok: false, reason: 'account_total_cap' }, `day +${d}`)
  // the three end, each having spent $0.10: the account is at 0.30, so two more fit (0.90), not a third (1.20)
  for (const r of rs) await end(db, await scan(db, a.id, r), 0.1)
  const later = NOW + 5 * 86400
  const r4 = reservation(await admit(db, a, later)), r5 = reservation(await admit(db, a, later))
  assert.deepEqual(await admit(db, a, later), { ok: false, reason: 'account_total_cap' })
  // they end having spent nothing: 0.30 again, so two more fit
  await end(db, await scan(db, a.id, r4), 0, later); await end(db, await scan(db, a.id, r5), 0, later)
  const r6 = reservation(await admit(db, a, later)), r7 = reservation(await admit(db, a, later))
  // a scan that recorded more than its reserve (the runner never does) counts in full, not capped at its reserve:
  // 0.30 + 0.75 + 0 = 1.05, refused (capped it would read 0.60 and admit)
  await end(db, await scan(db, a.id, r6), 0.75, later); await end(db, await scan(db, a.id, r7), 0, later)
  assert.deepEqual(await admit(db, a, later + 86400), { ok: false, reason: 'account_total_cap' })
  // a reservation links only to its own tenant's scan
  const b = await user(db, 'b'.repeat(32), 'b@gmail.com')
  const rb = reservation(await admit(db, b))
  await linkTrialReservation(db, a.id, rb, 'x'.repeat(24))
  assert.equal((await db.get<{ job_id: string | null }>('SELECT job_id FROM trial_reservations WHERE id = ?', [rb]))!.job_id, null)
})

bothEngines('trial ceilings: $10 a day globally, including scans still running from yesterday; a new day starts from what is still open', async ({ db }) => {
  // 34 accounts, one scan each at $0.30: 33 fit in $10 (9.90), the 34th does not
  const us = []
  for (let i = 0; i < 34; i++) us.push(await user(db, uid(i + 1), `u${i}@gmail.com`))
  const rs: string[] = []
  for (const u of us.slice(0, 33)) rs.push(reservation(await admit(db, u)))
  assert.deepEqual(await admit(db, us[33]), { ok: false, reason: 'global_daily_cap' })
  const last = us[33], tomorrow = NOW + 86400
  // the next day, while yesterday's 33 still run: they count against today too (a scan past midnight spends on both days)
  assert.deepEqual(await admit(db, last, tomorrow), { ok: false, reason: 'global_daily_cap' })
  const ids = []
  for (let i = 0; i < 33; i++) ids.push(await scan(db, us[i].id, rs[i]))
  assert.deepEqual(await admit(db, last, tomorrow), { ok: false, reason: 'global_daily_cap' }, 'running, linked: still counted')
  // 30 of them end yesterday at their full reserve: no longer today's; 3 end today, after midnight, at $0.30: still today's
  const midnight = (DAY + 1) * 86400
  for (let i = 0; i < 30; i++) await end(db, ids[i], 0.3, midnight - 60)
  for (let i = 30; i < 33; i++) await end(db, ids[i], 0.3, midnight + 60)
  // today: 0.90 from those three; 31 more fit (0.90 + 9.30 = 10.20 > 10, so 30: 0.90 + 9.00 = 9.90)
  const fresh = []
  for (let i = 0; i < 31; i++) fresh.push(await user(db, uid(100 + i), `n${i}@gmail.com`))
  let admitted = 0
  for (const u of fresh) if ((await admit(db, u, tomorrow)).ok) admitted++
  assert.equal(admitted, 30)
  assert.equal(DAY + 1, utcDay(tomorrow))
})

bothEngines('trial ceilings: concurrent workers on separate Postgres pools never pass the global or the account ceiling', async ({ db, kind, url, schema }) => {
  if (kind !== 'pg') return // SQLite runs one transaction at a time in-process; the race is between Postgres connections
  // global: 40 accounts admitted at once from 40 pools: exactly 33 ($9.90 of $10)
  const us = []
  for (let i = 0; i < 40; i++) us.push(await user(db, uid(i + 1), `u${i}@gmail.com`))
  const pools = us.map(() => pgDb({ connectionString: url!, searchPath: schema, max: 1 }))
  try {
    const rs = await Promise.all(us.map((u, i) => admit(pools[i], u)))
    assert.equal(rs.filter(r => r.ok).length, 33, JSON.stringify(rs.filter(r => !r.ok)))
    assert.ok(rs.filter(r => !r.ok).every(r => !r.ok && r.reason === 'global_daily_cap'))
    // account: one fresh account, 6 admissions at once from 6 pools, on another day: exactly 3 ($0.90 of $1)
    const solo = await user(db, 'f'.repeat(32), 'solo@gmail.com')
    const next = NOW + 2 * 86400
    await db.run('DELETE FROM trial_reservations') // clear the global day, so only the account ceiling binds
    const ss = await Promise.all(pools.slice(0, 6).map(p => admit(p, solo, next)))
    assert.equal(ss.filter(r => r.ok).length, 3, JSON.stringify(ss))
    assert.ok(ss.filter(r => !r.ok).every(r => !r.ok && r.reason === 'account_total_cap'))
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM trial_reservations WHERE tenant_id = ?', [solo.id]))!.n), 3)
  } finally { await Promise.all(pools.map(p => p.close())) }
})
