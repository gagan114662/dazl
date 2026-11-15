// Two pilot blockers found in the 2026-11-11 staging trial check (lib/billing/trial-budget.ts, lib/scan/estimate-request.ts):
// (A) a trial scan that died mid-run ("Stopped after an interruption", error accounting_uncertain) used up one of the account's
//     three free scan attempts even though the person got nothing; it now gives the place back. Its worst-case reserve STILL counts
//     against the account's dollar total and the day's budget, so the money caps ($0.30 / $1 / $10) are unchanged.
// (B) with the free scans used up, the cost screen still offered "Confirm and run", which then did nothing; the estimate now refuses
//     up front (verdict blocked, with what to do), for the same reasons POST /api/scan would refuse at confirm time.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, ledger, linkTrialReservation, settleTrialReservation, trialCaps, utcDay, type LedgerRow } from '../lib/billing/trial-budget.ts'
import { estimateRun, FREE_TRIAL_SCANS } from '../lib/scan/price-estimate.ts'
import { TRIAL_SCANS_PER_ACCOUNT } from '../lib/scan/trial.ts'
import { bothEngines } from './helpers/engines.ts'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { trialStatus } from '../lib/scan/trial.ts'
import { reapStaleRunningJobs } from '../lib/scan/store.ts'
import { reapStaleRunningJobs as reapStaleRunningJobsDb } from '../lib/scan/store-db.ts'
import { reapStaleScans } from '../lib/queue/scan-claimer.ts'

const NOW = 1_800_000_000, DAY = utcDay(NOW)
const caps = { DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' }
const mkUser = async (db: Db, id: string, email: string) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
let n = 0
const ended = async (db: Db, u: { id: string; email: string }, o: { status: string; error: string | null; spent: number; settle?: boolean }) => {
  const a = await admitTrialScan(db, u, { env: caps, now: NOW }); assert.ok(a.ok, JSON.stringify(a))
  const id = `job${String(++n).padStart(21, '0')}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, error, created_at, spend_reserved_usd, finished_at) VALUES (?, ?, 'b', 'i', 'l', ?, ?, ?, ?, ?)", [id, u.id, o.status, o.error, NOW, o.spent, NOW])
  await linkTrialReservation(db, u.id, a.reservation, id)
  if (o.settle !== false) await settleTrialReservation(db, id, Number((await db.get<{ a: number }>('SELECT attempts AS a FROM scan_jobs WHERE id = ?', [id]))!.a), NOW)
  return id
}
const row = (o: Partial<LedgerRow>): LedgerRow => ({ tenant_id: 'T', kind: 'scan', reserve_usd: 0.3, spent_usd: null, day: DAY, created_at: NOW, settled_at: NOW, settled_attempt: 1, status: 'failed', error: 'accounting_uncertain', attempts: 1, spend_reserved_usd: 0.03, ...o })

// ---- (A)
test('(A) ledger: a settled scan that stopped after an interruption does not count as a used free scan, but its reserve still counts as money', () => {
  const l = ledger([row({}), row({}), row({})], 'T', DAY)
  assert.equal(l.attempts, 0, 'three interrupted scans used no free scan')
  assert.ok(Math.abs(l.account - 0.09) < 1e-9, 'their worst-case spend still counts against the account total')
  assert.ok(Math.abs(l.today - 0.09) < 1e-9, 'and against the day')
})
test('(A) ledger: every other ending keeps its place (control: pins the existing rule)', () => {
  const one = (o: Partial<LedgerRow>) => ledger([row(o)], 'T', DAY).attempts
  assert.equal(one({ error: 'provider_error' }), 1, 'a paid failure keeps it')
  assert.equal(one({ error: 'cancelled', spend_reserved_usd: 0 }), 1, 'a cancellation keeps it')
  assert.equal(one({ status: 'done', error: null }), 1, 'a finished scan keeps it')
  assert.equal(one({ status: 'running', error: null, settled_at: null, settled_attempt: null }), 1, 'a running scan holds it')
  assert.equal(one({ settled_at: null, settled_attempt: null }), 1, 'an interruption whose run has not settled yet still holds it')
  assert.equal(one({ settled_attempt: 0 }), 1, 'an earlier attempt\'s settle does not release a later attempt')
  assert.equal(one({ status: 'queued', error: 'accounting_uncertain' }), 1, 'queued for a retry holds it')
  assert.equal(one({ kind: 'site_read', status: null, error: null }), 0, 'a website read is never an attempt (unchanged)')
})
// #1172 (Hermes decision): a trial scan stopped by a spending limit sends nothing and the person gets nothing, so its free scan is REFUNDED, like
// any scan that failed before any cost. Safe because such a scan sends no search, fetch or model call (test/scan-spend-cap-runner.test.ts '#1167 trial').
test('#1172 ledger: a settled trial scan stopped by a spending limit with nothing spent is refunded; one that spent something keeps its place', () => {
  const one = (o: Partial<LedgerRow>) => ledger([row(o)], 'T', DAY).attempts
  assert.equal(one({ error: 'budget_stopped', spend_reserved_usd: 0 }), 0, 'nothing spent: the free scan is given back')
  assert.equal(one({ error: 'budget_stopped', spend_reserved_usd: 0.09 }), 1, 'a scan that recorded spend keeps its place')
  assert.equal(one({ error: 'budget_stopped', spend_reserved_usd: 0, settled_at: null, settled_attempt: null }), 1, 'until its run has settled')
})
bothEngines('(A) admission: three interrupted scans leave all three free scans; the money caps still bind', async ({ db }) => {
  const u = await mkUser(db, 'a'.repeat(32), 'a@gmail.com')
  for (let i = 0; i < 3; i++) await ended(db, u, { status: 'failed', error: 'accounting_uncertain', spent: 0.03 })
  assert.equal((await admitTrialScan(db, u, { env: caps, now: NOW })).ok, true, 'a fourth attempt is admitted: the interruptions gave their places back')
  // control: the same three as ordinary paid failures use the places up
  const v = await mkUser(db, 'b'.repeat(32), 'b@gmail.com')
  for (let i = 0; i < 3; i++) await ended(db, v, { status: 'failed', error: 'provider_error', spent: 0.03 })
  assert.deepEqual(await admitTrialScan(db, v, { env: caps, now: NOW }), { ok: false, reason: 'attempts_cap' })
  // the dollar total still binds interruptions: each interrupted scan reserved $0.45 worst case -> $1 total refuses the third
  const w = await mkUser(db, 'c'.repeat(32), 'c@gmail.com')
  await ended(db, w, { status: 'failed', error: 'accounting_uncertain', spent: 0.45 })
  await ended(db, w, { status: 'failed', error: 'accounting_uncertain', spent: 0.45 })
  assert.deepEqual(await admitTrialScan(db, w, { env: caps, now: NOW }), { ok: false, reason: 'account_total_cap' }, 'interruptions cannot run past the $1 account total')
})

// ---- (B)
const base = { budget: null, payer: 'trial', limited: true, trialReserveUsd: 0.3 } as const
test('(B) estimate: a trial account with no free scans left is refused up front, with what to do', () => {
  for (const why of ['attempts_cap', 'account_total_cap', 'global_daily_cap', 'domain_used'] as const) {
    const e = estimateRun({ ...base, trialRefusal: why } as never)
    assert.equal(e.verdict.ok, false, why)
    assert.equal(e.verdict.reason, 'trial_unavailable', why)
    assert.ok(e.verdict.message.length > 20 && !/No dollar limit|Within your limit/.test(e.verdict.message), why)
    assert.ok(e.verdict.change.length >= 1, `${why}: says what to change`)
  }
  assert.match(estimateRun({ ...base, trialRefusal: 'attempts_cap' } as never).verdict.message, /used all 3 free trial scan attempts/)
  assert.match(estimateRun({ ...base, trialRefusal: 'attempts_cap' } as never).verdict.change.join(' '), /AI key/)
})
test('(B) estimate: no refusal, own key, or not-configured keep today\'s screen', () => {
  assert.equal(estimateRun({ ...base, trialRefusal: null } as never).verdict.ok, true)
  assert.equal(estimateRun({ ...base } as never).verdict.ok, true)
  assert.equal(estimateRun({ ...base, payer: 'you', trialRefusal: 'attempts_cap' } as never).verdict.ok, true, 'a run on the person\'s own key is never refused for the trial')
  assert.equal(estimateRun({ ...base, trialRefusal: 'not_configured' } as never).verdict.ok, true, 'unchanged: a deployment without a trial keeps its old screen')
  assert.equal(estimateRun({ ...base, trialRefusal: 'nonsense' } as never).verdict.ok, true, 'an unknown reason never blocks')
})
test('(B) the browser-safe copy of the free-scan count agrees with the server\'s', () => { assert.equal(FREE_TRIAL_SCANS, TRIAL_SCANS_PER_ACCOUNT); assert.notEqual(trialCaps(caps), null) })

// ---- the first check / usage counter (lib/scan/trial.ts) and admission must count the same (Hermes-PC review of 2bc77f12)
const withTrialEnv = async (fn: () => Promise<void>) => {
  const old = process.env.DAZL_TRIAL_ANTHROPIC_KEY; process.env.DAZL_TRIAL_ANTHROPIC_KEY = 'sk-ant...ture'
  try { await fn() } finally { if (old === undefined) delete process.env.DAZL_TRIAL_ANTHROPIC_KEY; else process.env.DAZL_TRIAL_ANTHROPIC_KEY = old }
}
const account = async (id = 'a'.repeat(32), email = 'a@gmail.com') => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw)
  return { raw, db, u: await mkUser(db, id, email) }
}
// one trial scan the way POST /api/scan leaves it: admission, job, trial_scans row, then the given ending
const trialScan = async (x: Awaited<ReturnType<typeof account>>, o: { status: string; error: string | null; spent: number; settle: boolean }) => {
  const id = await ended(x.db, x.u, { status: o.status, error: o.error, spent: o.spent, settle: o.settle })
  x.raw.prepare("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'h')").run(x.u.id, id)
  return id
}
const both = async (x: Awaited<ReturnType<typeof account>>) => ({
  first: trialStatus(x.raw, x.u.id, '1.1.1.1').used,
  ledger: ledger(await x.db.all<LedgerRow>("SELECT r.tenant_id, r.kind, r.reserve_usd, r.spent_usd, r.day, r.created_at, r.settled_at, r.settled_attempt, j.status, j.error, j.candidates, j.attempts, j.spend_reserved_usd FROM trial_reservations r LEFT JOIN scan_jobs j ON j.id = r.job_id WHERE r.tenant_id = ?", [x.u.id]), x.u.id, DAY).attempts,
})
test('the first check (trial.ts) and admission (ledger) count the same used scans for every ending', async () => {
  await withTrialEnv(async () => {
    const endings: [string, { status: string; error: string | null; spent: number; settle: boolean }][] = [
      ['settled interruption', { status: 'failed', error: 'accounting_uncertain', spent: 0.03, settle: true }],
      ['unsettled interruption', { status: 'failed', error: 'accounting_uncertain', spent: 0.03, settle: false }],
      ['paid failure', { status: 'failed', error: 'provider_error', spent: 0.03, settle: true }],
      ['cancelled', { status: 'failed', error: 'cancelled', spent: 0, settle: true }],
      ['failed before cost', { status: 'failed', error: 'trial_unavailable', spent: 0, settle: true }],
      ['stopped by a spending limit, nothing spent (#1172)', { status: 'failed', error: 'budget_stopped', spent: 0, settle: true }],
      ['done', { status: 'done', error: null, spent: 0.05, settle: true }],
    ]
    for (const [name, e] of endings) {
      const x = await account(); await trialScan(x, e)
      const c = await both(x)
      assert.equal(c.first, c.ledger, `${name}: the route's first check and admission must agree (${JSON.stringify(c)})`)
    }
    const s = await account(); for (let i = 0; i < 3; i++) await trialScan(s, endings[0]![1])
    assert.deepEqual(await both(s), { first: 0, ledger: 0 }, 'three settled interruptions: nothing used, by both counts')
    assert.equal(trialStatus(s.raw, s.u.id, '1.1.1.1').remaining, 3, 'the usage counter shows 3 free scans left')
    // #1172: three scans stopped by a spending limit with nothing spent use no free scan, by both counts
    const l = await account(); for (let i = 0; i < 3; i++) await trialScan(l, { status: 'failed', error: 'budget_stopped', spent: 0, settle: true })
    assert.deepEqual(await both(l), { first: 0, ledger: 0 }, 'three limit stops: nothing used, by both counts')
    assert.equal(trialStatus(l.raw, l.u.id, '1.1.1.1').remaining, 3)
    const u = await account(); for (let i = 0; i < 3; i++) await trialScan(u, endings[1]![1])
    assert.deepEqual(await both(u), { first: 3, ledger: 3 }, 'unsettled interruptions keep their places until settled')
  })
})
test('a dead worker\'s interrupted trial scan is settled by the stale-job reaper and gives its free scan back (sync and Db reapers)', async () => {
  await withTrialEnv(async () => {
    for (const kind of ['sync', 'db'] as const) {
      const x = await account()
      const a = await admitTrialScan(x.db, x.u, { env: caps, now: NOW }); assert.ok(a.ok)
      const id = `job${String(++n).padStart(21, '0')}`
      x.raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, claimed_at, attempts, spend_reserved_usd, funded_by) VALUES (?, ?, 'b', 'i', 'l', 'running', 1, 1, 0.03, 'trial')").run(id, x.u.id)
      await linkTrialReservation(x.db, x.u.id, a.reservation, id)
      x.raw.prepare("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'h')").run(x.u.id, id)
      x.raw.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('c' || ?, ?, ?, 1, 'llm.anthropic', 0.03, 'reserved', 1)").run(id, x.u.id, id)
      assert.deepEqual(await both(x), { first: 1, ledger: 1 }, `${kind}: before the reaper the dead scan holds its place`)
      if (kind === 'sync') reapStaleRunningJobs(x.raw); else await reapStaleRunningJobsDb(x.db)
      const j = x.raw.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id)
      assert.deepEqual(j, { status: 'failed', error: 'accounting_uncertain' }, `${kind}: fixture: the reaper ended it interrupted`)
      assert.deepEqual(await both(x), { first: 0, ledger: 0 }, `${kind}: settled by the reaper, so the free scan is given back by both counts`)
      const cost = x.raw.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs WHERE id = ?').get(id) as { s: number }
      assert.equal(cost.s, 0.03, 'its recorded spend is kept (still counts as money)')
    }
  })
})
test('the reaper leaves a trial scan that is still running, a done scan and an already settled one alone', async () => {
  await withTrialEnv(async () => {
    const x = await account()
    const run = await trialScan(x, { status: 'running', error: null, spent: 0, settle: false })
    const done = await trialScan(x, { status: 'done', error: null, spent: 0.05, settle: false })
    reapStaleRunningJobs(x.raw)
    const r = x.raw.prepare('SELECT job_id, settled_at FROM trial_reservations WHERE tenant_id = ? ORDER BY created_at, rowid').all(x.u.id) as { job_id: string; settled_at: number | null }[]
    assert.deepEqual(r.map(z => [z.job_id === run || z.job_id === done, z.settled_at]), [[true, null], [true, null]], 'running and done reservations stay unsettled')
  })
})

// ---- copy on the blocked screen (review points 3 and 4)
test('(B) copy: a full day or a spent allowance never says "used 3 of 3" for a fresh account; attempts_cap says all used', () => {
  const day = estimateRun({ ...base, trialRefusal: 'global_daily_cap', trialUsed: 0 } as never)
  assert.doesNotMatch(day.verdict.message, /3 of 3/)
  assert.match(day.verdict.message, /fully booked/)
  assert.match(day.verdict.message, /used 0 of 3/)
  const money = estimateRun({ ...base, trialRefusal: 'account_total_cap', trialUsed: 1 } as never)
  assert.doesNotMatch(money.verdict.message, /3 of 3/); assert.match(money.verdict.message, /used 1 of 3/)
  assert.match(estimateRun({ ...base, trialRefusal: 'attempts_cap', trialUsed: 0 } as never).verdict.message, /used all 3 free trial scan attempts/)
  assert.doesNotMatch(day.verdict.message, /used 3 of 3/); assert.doesNotMatch(estimateRun({ ...base, trialRefusal: 'global_daily_cap' } as never).verdict.message, /3 of 3/, 'unknown count reads 0, never 3')
})
test('(B) an unpriced trial model does not overwrite the trial refusal', () => {
  const e = estimateRun({ ...base, trialRefusal: 'attempts_cap', model: 'claude-unlisted-9', priceModel: () => null } as never)
  assert.equal(e.verdict.reason, 'trial_unavailable'); assert.equal(e.verdict.ok, false)
  assert.doesNotMatch(e.verdict.message, /configuration problem|no listed price/)
})

test('the queue claimer\'s reaper (reapStaleScans) settles a dead worker\'s interrupted trial scan too', async () => {
  await withTrialEnv(async () => {
    const x = await account()
    const a = await admitTrialScan(x.db, x.u, { env: caps, now: NOW }); assert.ok(a.ok)
    const id = `job${String(++n).padStart(21, '0')}`
    x.raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, claimed_at, attempts, spend_reserved_usd, funded_by) VALUES (?, ?, 'b', 'i', 'l', 'running', 1, 1, 0.03, 'trial')").run(id, x.u.id)
    await linkTrialReservation(x.db, x.u.id, a.reservation, id)
    x.raw.prepare("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'h')").run(x.u.id, id)
    x.raw.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('c' || ?, ?, ?, 1, 'llm.anthropic', 0.03, 'reserved', 1)").run(id, x.u.id, id)
    assert.deepEqual(await both(x), { first: 1, ledger: 1 })
    assert.equal(await reapStaleScans(x.db, 60, NOW), 1)
    assert.deepEqual(x.raw.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id), { status: 'failed', error: 'accounting_uncertain' })
    assert.deepEqual(await both(x), { first: 0, ledger: 0 }, 'settled by the claimer reaper: the free scan is given back')
  })
})
