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
