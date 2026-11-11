// The cost screen's "N of $1.00 free trial allowance left" line (#409 trial UX follow-up). Read-only: admission, the $0.30 / $1 / $10 caps and
// the confirmation ack are untouched.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, linkTrialReservation, settleTrialReservation, trialAllowanceLeft, utcDay } from '../lib/billing/trial-budget.ts'
import { estimateRun } from '../lib/scan/price-estimate.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = 1_800_000_000
const caps = { DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' }
const mkUser = async (db: Db, id: string, email: string) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
let n = 0
const scan = async (db: Db, u: { id: string; email: string }, o: { status: string; error: string | null; spent: number; settle: boolean }) => {
  const a = await admitTrialScan(db, u, { env: caps, now: NOW }); assert.ok(a.ok, JSON.stringify(a))
  const id = `alw${String(++n).padStart(21, '0')}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, error, created_at, spend_reserved_usd, finished_at) VALUES (?, ?, 'b', 'i', 'l', ?, ?, ?, ?, ?)", [id, u.id, o.status, o.error, NOW, o.spent, NOW])
  await linkTrialReservation(db, u.id, a.reservation, id)
  if (o.settle) await settleTrialReservation(db, id, Number((await db.get<{ a: number }>('SELECT attempts AS a FROM scan_jobs WHERE id = ?', [id]))!.a), NOW)
}
const left = (db: Db, id: string, env: Record<string, string | undefined> = caps) => trialAllowanceLeft(db, id, { env, now: NOW })

bothEngines('allowance left: a fresh account has all of it; settled scans count what they recorded; a running one counts its full reserve', async ({ db }) => {
  const u = await mkUser(db, 'a'.repeat(32), 'a@gmail.com')
  assert.deepEqual(await left(db, u.id), { left_usd: 1, total_usd: 1 })
  await scan(db, u, { status: 'done', error: null, spent: 0.12, settle: true })
  const a = (await left(db, u.id))!
  assert.ok(Math.abs(a.left_usd - 0.88) < 1e-9, `left ${a.left_usd}`)
  await scan(db, u, { status: 'running', error: null, spent: 0.02, settle: false })
  const b = (await left(db, u.id))!
  assert.ok(Math.abs(b.left_usd - 0.58) < 1e-9, `0.12 recorded + 0.30 reserve for the running scan: left ${b.left_usd}`)
})
bothEngines('allowance left: another account\'s trial work never counts; never below 0', async ({ db }) => {
  const u = await mkUser(db, 'b'.repeat(32), 'b@gmail.com'), v = await mkUser(db, 'c'.repeat(32), 'c@gmail.com')
  await scan(db, v, { status: 'done', error: null, spent: 0.3, settle: true })
  assert.equal((await left(db, u.id))!.left_usd, 1)
  for (const s of [0.3, 0.3]) await scan(db, u, { status: 'done', error: null, spent: s, settle: true })
  assert.ok(Math.abs((await left(db, u.id))!.left_usd - 0.4) < 1e-9)
  assert.equal((await left(db, u.id, { ...caps, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.1' }))!.left_usd, 0, 'a smaller total than recorded spend clamps to 0')
})
bothEngines('allowance left: an unconfigured trial or an unreadable ledger gives no line (null), never a guess', async ({ db }) => {
  const u = await mkUser(db, 'd'.repeat(32), 'd@gmail.com')
  assert.equal(await left(db, u.id, {}), null, 'no wallet ceilings configured')
  const broken = { ...db, all: async () => { throw new Error('db down') } } as unknown as Db
  assert.equal(await trialAllowanceLeft(broken, u.id, { env: caps, now: NOW }), null)
  assert.equal(utcDay(NOW) > 0, true)
})

const base = { budget: null, limited: true, trialReserveUsd: 0.3 } as const
test('estimate: the allowance rides on a trial estimate, never on an own-key one, garbage is dropped, and the ack does not depend on it', () => {
  const none = estimateRun({ ...base, payer: 'trial' })
  const withA = estimateRun({ ...base, payer: 'trial', trialAllowance: { left_usd: 0.64, total_usd: 1 } })
  assert.deepEqual(withA.trial_allowance, { left_usd: 0.64, total_usd: 1 })
  assert.equal(none.trial_allowance, undefined)
  assert.equal(withA.ack, none.ack, 'display only: POST /api/scan (which does not read it) must still accept the ack')
  assert.equal(estimateRun({ ...base, payer: 'you', trialAllowance: { left_usd: 0.64, total_usd: 1 } }).trial_allowance, undefined)
  for (const bad of [{ left_usd: NaN, total_usd: 1 }, { left_usd: -1, total_usd: 1 }, { left_usd: 2, total_usd: 1 }, { left_usd: 0.5, total_usd: 0 }]) assert.equal(estimateRun({ ...base, payer: 'trial', trialAllowance: bad }).trial_allowance, undefined)
  assert.deepEqual(withA.verdict, none.verdict, 'the verdict does not change')
})
