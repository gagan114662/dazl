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
import { admitTrialScan, linkTrialReservation, releaseTrialReservation, settleTrialReservation, trialCaps, utcDay } from '../lib/billing/trial-budget.ts'
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
// The scan reads 'done' (finish), then its enrichment runs (still paid: buyer fit), then the run settles the reservation
const finish = (db: Db, jobId: string, spent: number, finishedAt = NOW) =>
  db.run("UPDATE scan_jobs SET status = 'done', spend_reserved_usd = ?, finished_at = ?, enrich_started_at = ?, enrich_finished_at = NULL WHERE id = ?", [spent, finishedAt, finishedAt, jobId])
// the run of the job's CURRENT attempt settles (runner: the last step of runJob)
const settle = async (db: Db, jobId: string, at = NOW) => settleTrialReservation(db, jobId, Number((await db.get<{ a: number }>('SELECT attempts AS a FROM scan_jobs WHERE id = ?', [jobId]))!.a), at)
// a retry is claimed: a new attempt starts running
const claimAgain = (db: Db, jobId: string) => db.run("UPDATE scan_jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?", [jobId])
const end = async (db: Db, jobId: string, spent: number, finishedAt = NOW) => { await finish(db, jobId, spent, finishedAt); await settle(db, jobId, finishedAt) }
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

// The account ceiling binds before the three attempts only when it is below three reserves: these use $0.70 (two
// $0.30 scans fit, a third does not); the proposed $1 with three attempts is pinned by the attempts tests below.
const acct = { ...caps, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.70' }
bothEngines('trial ceilings: the per-account total holds across days; finished scans count what they spent, in full', async ({ db }) => {
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com')
  const at = (now = NOW) => admitTrialScan(db, a, { env: acct, now })
  // two running scans: 0.60 of 0.70; a third ($0.30) would reach 0.90
  const rs = [reservation(await at()), reservation(await at())]
  assert.deepEqual(await at(), { ok: false, reason: 'account_total_cap' })
  // the same account on later days: still refused (a daily per-user cap would have reset here)
  for (const d of [1, 2, 30]) assert.deepEqual(await at(NOW + d * 86400), { ok: false, reason: 'account_total_cap' }, `day +${d}`)
  // they end having spent $0.10 and nothing: the account is at 0.10, so a third fits (0.40)
  await end(db, await scan(db, a.id, rs[0]), 0.1); await end(db, await scan(db, a.id, rs[1]), 0)
  assert.equal((await at(NOW + 5 * 86400)).ok, true)
  // a scan that recorded more than its reserve (the runner never does) counts in full, not capped at its reserve:
  // 0.45 + 0.30 = 0.75 > 0.70, refused (capped at its reserve it would read 0.60 and admit)
  const c = await user(db, 'c'.repeat(32), 'c@gmail.com')
  await end(db, await scan(db, c.id, reservation(await admitTrialScan(db, c, { env: acct, now: NOW }))), 0.45)
  assert.deepEqual(await admitTrialScan(db, c, { env: acct, now: NOW + 86400 }), { ok: false, reason: 'account_total_cap' })
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
    // account: one fresh account, 6 admissions at once from 6 pools, on another day: exactly 2 ($0.60 of $0.70)
    const solo = await user(db, 'f'.repeat(32), 'solo@gmail.com')
    const next = NOW + 2 * 86400
    await db.run('DELETE FROM trial_reservations') // clear the global day, so only the account ceiling binds
    const ss = await Promise.all(pools.slice(0, 6).map(p => admitTrialScan(p, solo, { env: acct, now: next })))
    assert.equal(ss.filter(r => r.ok).length, 2, JSON.stringify(ss))
    assert.ok(ss.filter(r => !r.ok).every(r => !r.ok && r.reason === 'account_total_cap'))
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM trial_reservations WHERE tenant_id = ?', [solo.id]))!.n), 2)
  } finally { await Promise.all(pools.map(p => p.close())) }
})

bothEngines('trial ceilings: a scan that reads done but is still enriching keeps its full reserve, on the account and the day', async ({ db }) => {
  // global $0.59 left for two scans of $0.30: A's scan is done with $0.01 recorded, but its enrichment (buyer fit, a
  // paid model call under its per-scan guard) has not finished, so it may still spend up to its $0.30
  const day = { ...caps, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.59' }
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com'), b = await user(db, 'b'.repeat(32), 'b@gmail.com')
  const ja = await scan(db, a.id, reservation(await admitTrialScan(db, a, { env: day, now: NOW })))
  await finish(db, ja, 0.01)
  assert.deepEqual(await admitTrialScan(db, b, { env: day, now: NOW }), { ok: false, reason: 'global_daily_cap' }, 'done-but-enriching counts in full')
  // both admitted at once while it enriches (separate pools on Postgres): still neither
  const both = await Promise.all([admitTrialScan(db, b, { env: day, now: NOW }), admitTrialScan(db, b, { env: day, now: NOW })])
  assert.ok(both.every(r => !r.ok && r.reason === 'global_daily_cap'), JSON.stringify(both))
  await settle(db, ja)
  assert.equal((await admitTrialScan(db, b, { env: day, now: NOW })).ok, true, 'once its paid work settled, it counts what it spent ($0.01)')
  // the account ceiling the same way: two scans done at $0.01 each but still enriching are $0.60 of $0.70
  const c = await user(db, 'c'.repeat(32), 'c@gmail.com')
  const jc = []
  for (let i = 0; i < 2; i++) jc.push(await scan(db, c.id, reservation(await admitTrialScan(db, c, { env: acct, now: NOW }))))
  for (const j of jc) await finish(db, j, 0.01)
  assert.deepEqual(await admitTrialScan(db, c, { env: acct, now: NOW + 3 * 86400 }), { ok: false, reason: 'account_total_cap' })
  for (const j of jc) await settle(db, j, NOW + 60)
  assert.equal((await admitTrialScan(db, c, { env: acct, now: NOW + 3 * 86400 })).ok, true, '$0.02 spent once settled')
})

bothEngines('trial ceilings: enrichment that crosses midnight counts on the day it settles; a retry counts in full again', async ({ db }) => {
  const day = { ...caps, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.59' }
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com'), b = await user(db, 'b'.repeat(32), 'b@gmail.com')
  const midnight = (DAY + 1) * 86400
  // admitted and finished before midnight; its enrichment is still running after it
  const ja = await scan(db, a.id, reservation(await admitTrialScan(db, a, { env: day, now: midnight - 120 })))
  await finish(db, ja, 0.01, midnight - 60)
  assert.deepEqual(await admitTrialScan(db, b, { env: day, now: midnight + 60 }), { ok: false, reason: 'global_daily_cap' }, 'the new day sees it in full while it still enriches')
  await settle(db, ja, midnight + 30) // its paid work ended after midnight: it belongs to the new day too, at what it spent
  const rb = await admitTrialScan(db, b, { env: day, now: midnight + 60 })
  assert.equal(rb.ok, true)
  // the new day now holds 0.01 (A, settled today) + 0.30 (B, running): with $0.605 a third scan ($0.30) reaches 0.61,
  // refused only because A's spend counts on the day its work ended (by its finish, yesterday, it would be 0.60 and fit)
  const c = await user(db, 'c'.repeat(32), 'c@gmail.com')
  assert.deepEqual(await admitTrialScan(db, c, { env: { ...caps, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.605' }, now: midnight + 90 }), { ok: false, reason: 'global_daily_cap' })
  // a retried scan: attempt 1 fails and its run settles, but the scan goes back to the queue (pending), then runs again
  await db.run('DELETE FROM trial_reservations')
  const d = await user(db, 'd'.repeat(32), 'd@gmail.com'), e = await user(db, 'e'.repeat(32), 'e@gmail.com')
  const jd = await scan(db, d.id, reservation(await admitTrialScan(db, d, { env: day, now: midnight + 100 })))
  await db.run("UPDATE scan_jobs SET status = 'pending', spend_reserved_usd = 0.01 WHERE id = ?", [jd]); await settle(db, jd, midnight + 110)
  assert.deepEqual(await admitTrialScan(db, e, { env: day, now: midnight + 120 }), { ok: false, reason: 'global_daily_cap' }, 'queued for a retry: in full despite the earlier settle')
  await claimAgain(db, jd)
  await finish(db, jd, 0.02, midnight + 200)
  assert.deepEqual(await admitTrialScan(db, e, { env: day, now: midnight + 210 }), { ok: false, reason: 'global_daily_cap' }, 'finished again, enriching: in full until it settles again')
  await settle(db, jd, midnight + 300)
  assert.equal((await admitTrialScan(db, e, { env: day, now: midnight + 310 })).ok, true)
})

bothEngines('trial ceilings: a retry queued before midnight still counts in full on the next day', async ({ db }) => {
  const day = { ...caps, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.59' }
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com'), b = await user(db, 'b'.repeat(32), 'b@gmail.com')
  const midnight = (DAY + 1) * 86400
  // A, admitted yesterday: attempt 1 records $0.01, fails and goes back to the queue; its run settles yesterday
  const ja = await scan(db, a.id, reservation(await admitTrialScan(db, a, { env: day, now: midnight - 600 })))
  await db.run("UPDATE scan_jobs SET attempts = 1, status = 'pending', spend_reserved_usd = 0.01 WHERE id = ?", [ja])
  await settle(db, ja, midnight - 300)
  // today: A's retry can still spend its remaining reserve, so B ($0.30) does not fit $0.59
  assert.deepEqual(await admitTrialScan(db, b, { env: day, now: midnight + 60 }), { ok: false, reason: 'global_daily_cap' })
  await claimAgain(db, ja)
  assert.deepEqual(await admitTrialScan(db, b, { env: day, now: midnight + 90 }), { ok: false, reason: 'global_daily_cap' }, 'claimed again: in full')
  await finish(db, ja, 0.02, midnight + 100); await settle(db, ja, midnight + 120)
  assert.equal((await admitTrialScan(db, b, { env: day, now: midnight + 130 })).ok, true, 'its current attempt settled today, at its spend')
})

bothEngines('trial ceilings: the settle of an earlier attempt never releases a later attempt, even in the same second', async ({ db }) => {
  const day = { ...caps, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.59' }
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com'), b = await user(db, 'b'.repeat(32), 'b@gmail.com')
  const ja = await scan(db, a.id, reservation(await admitTrialScan(db, a, { env: day, now: NOW })))
  await db.run("UPDATE scan_jobs SET attempts = 1 WHERE id = ?", [ja])
  await db.run("UPDATE scan_jobs SET status = 'pending' WHERE id = ?", [ja]); await settle(db, ja, NOW + 10) // attempt 1 ends for a retry
  await claimAgain(db, ja); await finish(db, ja, 0.01, NOW + 10) // attempt 2 reads done in that same second, still enriching
  assert.deepEqual(await admitTrialScan(db, b, { env: day, now: NOW + 10 }), { ok: false, reason: 'global_daily_cap' }, 'attempt 1 settling does not settle attempt 2')
  await settle(db, ja, NOW + 11)
  assert.equal((await admitTrialScan(db, b, { env: day, now: NOW + 12 })).ok, true)
})

bothEngines('trial ceilings: a retry done before midnight but enriching after it is selected for the new day despite the old settle', async ({ db }) => {
  const day = { ...caps, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.59' }
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com'), b = await user(db, 'b'.repeat(32), 'b@gmail.com')
  const midnight = (DAY + 1) * 86400
  const ja = await scan(db, a.id, reservation(await admitTrialScan(db, a, { env: day, now: midnight - 900 })))
  await db.run("UPDATE scan_jobs SET attempts = 1, status = 'pending' WHERE id = ?", [ja]); await settle(db, ja, midnight - 800) // attempt 1 settles yesterday
  await claimAgain(db, ja); await finish(db, ja, 0.01, midnight - 60) // attempt 2 reads done yesterday, its enrichment runs past midnight
  assert.deepEqual(await admitTrialScan(db, b, { env: day, now: midnight + 60 }), { ok: false, reason: 'global_daily_cap' })
  await settle(db, ja, midnight + 90)
  assert.equal((await admitTrialScan(db, b, { env: day, now: midnight + 120 })).ok, true)
})

// A trial scan that ended failed (or cancelled) after reserving `spent` on paid steps, its attempt settled
const fail = async (db: Db, jobId: string, error: string, spent: number) => {
  await db.run("UPDATE scan_jobs SET status = 'failed', error = ?, spend_reserved_usd = ?, finished_at = ? WHERE id = ?", [error, spent, NOW, jobId])
  await settle(db, jobId)
}

bothEngines('trial attempts: three admitted attempts per account that can cost money, paid failures and cancellations included', async ({ db }) => {
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com')
  for (let i = 0; i < 3; i++) await fail(db, await scan(db, a.id, reservation(await admit(db, a))), 'provider_error', 0.02)
  // $0.06 of $1 spent: the attempts run out, not the money; on later days too
  assert.deepEqual(await admit(db, a), { ok: false, reason: 'attempts_cap' })
  assert.deepEqual(await admit(db, a, NOW + 40 * 86400), { ok: false, reason: 'attempts_cap' })
  // what keeps a place: a cancellation that reserved nothing, a reservation that never got its scan, a running scan,
  // a failure whose attempt has not settled yet; what gives it back: a failure before any cost, once settled
  const b = await user(db, 'b'.repeat(32), 'b@gmail.com')
  await fail(db, await scan(db, b.id, reservation(await admit(db, b))), 'cancelled', 0)
  reservation(await admit(db, b))                                                              // never linked to a scan
  const early = await scan(db, b.id, reservation(await admit(db, b)))
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'trial_unavailable', spend_reserved_usd = 0, finished_at = ? WHERE id = ?", [NOW, early])
  assert.deepEqual(await admit(db, b), { ok: false, reason: 'attempts_cap' }, 'failed before cost, but its run has not settled yet')
  await settle(db, early)
  const again = await scan(db, b.id, reservation(await admit(db, b)))                          // the released place, used again
  assert.deepEqual(await admit(db, b), { ok: false, reason: 'attempts_cap' }, 'running: holds the third place')
  await fail(db, again, 'provider_error', 0.01)
  assert.deepEqual(await admit(db, b), { ok: false, reason: 'attempts_cap' }, 'a paid failure keeps it')
})

bothEngines('trial attempts: concurrent admissions on separate Postgres pools never pass three', async ({ db, kind, url, schema }) => {
  if (kind !== 'pg') return // SQLite runs one transaction at a time in-process; the race is between Postgres connections
  const a = await user(db, 'a'.repeat(32), 'a@gmail.com')
  for (let i = 0; i < 2; i++) await fail(db, await scan(db, a.id, reservation(await admit(db, a))), 'provider_error', 0.02)
  const pools = Array.from({ length: 5 }, () => pgDb({ connectionString: url!, searchPath: schema, max: 1 }))
  try {
    const rs = await Promise.all(pools.map(p => admit(p, a)))
    assert.equal(rs.filter(r => r.ok).length, 1, JSON.stringify(rs))
    assert.ok(rs.filter(r => !r.ok).every(r => !r.ok && r.reason === 'attempts_cap'))
  } finally { await Promise.all(pools.map(p => p.close())) }
})

bothEngines('releasing an unlinked reservation gives the attempt and budget back; a linked reservation, or another tenant\'s, is never released', async ({ db }) => {
  const a = await user(db, 'c'.repeat(32), 'c@gmail.com'), b = await user(db, 'd'.repeat(32), 'd@gmail.com')
  const r1 = reservation(await admit(db, a)); assert.equal(await releaseTrialReservation(db, b.id, r1), false, 'another tenant cannot release it')
  assert.equal(await releaseTrialReservation(db, a.id, r1), true); assert.equal(await releaseTrialReservation(db, a.id, r1), false, 'only once')
  for (let i = 0; i < 3; i++) { const r = reservation(await admit(db, a)); await scan(db, a.id, r, { status: 'done', spent: 0.02 }) }   // three linked attempts fill the cap
  const linked = (await db.get<{ id: string }>('SELECT id FROM trial_reservations WHERE tenant_id = ? LIMIT 1', [a.id]))!.id
  assert.equal(await releaseTrialReservation(db, a.id, linked), false, 'a reservation linked to a scan is never released')
  assert.equal((await admit(db, a)).ok, false, 'the cap counts the three real scans, not the released attempt')
})
