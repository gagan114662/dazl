// Adopted from the adversarial probe on #444 d6c89bf2 (scratchpad attack-444.md: B1, B2, B3, B3b, B8), rewritten against
// what the read path does now: a read whose call failed settles at its reserve and ends (never counts on later days); a
// read refused before any call is released (nothing in the wallet, the account's read back); refusals for money, busy or
// throttle never touch the account's counter. Both engines. Synthetic accounts; no provider, no fetch.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, admitTrialSiteReadBudget, settleTrialSiteRead, trialRefusal } from '../lib/billing/trial-budget.ts'
import { admitTrialSiteRead, trialSiteReadsPerDay } from '../lib/scan/trial-site-read.ts'
import { bothEngines } from './helpers/engines.ts'

const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
const ENV = { DAZL_TRIAL_ANTHROPIC_KEY: OP, DAZL_TRIAL_SITE_READS_PER_DAY: '1000', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' }
const wallet = (account: string, daily: string, extra: Record<string, string> = {}) => ({ ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: account, DAZL_TRIAL_GLOBAL_DAILY_USD: daily, ...extra })
const user = async (db: Db, id: string, email: string) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
const uid = (n: number) => n.toString(16).padStart(32, '0')
const limiter = () => {
  const n = new Map<string, number>()
  const f = async (key: string, max: number) => { const c = (n.get(key) ?? 0) + 1; n.set(key, c); return { ok: c <= max, retryAfterS: 60 } }
  return Object.assign(f, { counts: n, refund: async (key: string) => { n.set(key, (n.get(key) ?? 1) - 1); return true } })
}
const DAY = 86400

bothEngines('probe B1: a read admitted on day 0 and never settled (crash) does not shrink day +1, +30 or +365\'s global budget; a failed call settled at its reserve does not either', async ({ db }) => {
  const NOW = 1_800_000_000
  const env = wallet('10', '0.30')
  const a = await user(db, uid(1), 'b1a@gmail.com')
  const ghost = await admitTrialSiteReadBudget(db, a, { env, now: NOW })
  assert.ok(ghost.ok)
  const failed = await admitTrialSiteReadBudget(db, a, { env, now: NOW })
  assert.ok(failed.ok)
  if (failed.ok) await settleTrialSiteRead(db, a.id, failed.reservation, null, NOW + 30)
  // Would a $0.30 scan of another account fit the $0.30 day on each later day? Asked without reserving (trialRefusal), so
  // the probe's own scans do not become unsettled scan reservations that count on the days after them.
  const reasons: Record<string, string | null> = {}
  const b = await user(db, uid(2), 'b1b@gmail.com')
  for (const [label, at] of [['+1d', NOW + DAY], ['+30d', NOW + 30 * DAY], ['+365d', NOW + 365 * DAY]] as const) reasons[label] = await trialRefusal(db, b, { env, now: at })
  assert.deepEqual(reasons, { '+1d': null, '+30d': null, '+365d': null })
  // On day 0 itself both still count (two reads at $0.05 against a $0.30 day: a $0.30 scan does not fit).
  assert.deepEqual(await admitTrialScan(db, await user(db, uid(9), 'b1z@gmail.com'), { env, now: NOW + 60 }), { ok: false, reason: 'global_daily_cap' })
})

bothEngines('probe B2: three reads refused before any call leave the founder\'s third free scan; three reads whose calls failed keep their money on the account (stated, not hidden)', async ({ db }) => {
  const env = ENV // the PR's own fixture values: account total $1, scan reserve $0.30
  const a = await user(db, uid(20), 'b2@gmail.com')
  assert.equal((await admitTrialScan(db, a, { env })).ok, true)
  assert.equal((await admitTrialScan(db, a, { env })).ok, true)
  const lim = limiter()
  for (let i = 0; i < 3; i++) { const r = await admitTrialSiteRead(db, a, '203.0.113.9', { env, limit: lim, refund: lim.refund }); assert.ok(r.ok, `read ${i}`); if (r.ok) await r.release() }
  assert.equal((await admitTrialScan(db, a, { env })).ok, true, 'three released reads: the third scan fits $1')
  assert.equal(lim.counts.get(`trial-site:${a.id}`) ?? 0, 0, 'and the account\'s reads were given back')
  // Calls that were made and failed: $0.05 each stays on the account; the third scan is refused by the money ceiling and
  // the usage route says so (account_total_cap), never that the attempts are used.
  const b = await user(db, uid(21), 'b2b@gmail.com')
  assert.equal((await admitTrialScan(db, b, { env })).ok, true); assert.equal((await admitTrialScan(db, b, { env })).ok, true)
  for (let i = 0; i < 3; i++) { const r = await admitTrialSiteRead(db, b, '203.0.113.10', { env, limit: limiter() }); assert.ok(r.ok); if (r.ok) await r.settle(null) }
  assert.deepEqual(await admitTrialScan(db, b, { env }), { ok: false, reason: 'account_total_cap' })
  assert.equal(await trialRefusal(db, b, { env }), 'account_total_cap')
  // Three settled successful reads (~$0.0105 each) leave room.
  const d = await user(db, uid(22), 'b2d@gmail.com')
  assert.equal((await admitTrialScan(db, d, { env })).ok, true); assert.equal((await admitTrialScan(db, d, { env })).ok, true)
  for (let i = 0; i < 3; i++) { const r = await admitTrialSiteRead(db, d, '203.0.113.11', { env, limit: limiter() }); assert.ok(r.ok); if (r.ok) await r.settle(0.0105) }
  assert.equal((await admitTrialScan(db, d, { env })).ok, true)
})

bothEngines('probe B3/B3b: refusals by the wallet (day full) or the deployment ceiling (busy) touch no counter of the account; with room again the reads are all there', async ({ db }) => {
  const a = await user(db, uid(30), 'b3@gmail.com')
  const lim = limiter()
  const filler = await user(db, uid(31), 'b3f@gmail.com')
  assert.equal((await admitTrialScan(db, filler, { env: wallet('10', '0.30') })).ok, true, 'another account\'s scan fills the day')
  for (let i = 0; i < 3; i++) assert.deepEqual(await admitTrialSiteRead(db, a, '203.0.113.30', { env: wallet('10', '0.30'), limit: lim }), { ok: false, reason: 'global_daily_cap' })
  assert.deepEqual([...lim.counts], [], 'wallet refusals: no counter touched at all')
  assert.equal((await admitTrialSiteRead(db, a, '203.0.113.30', { env: wallet('10', '100'), limit: lim })).ok, true, 'room again: admitted')
  // busy: the deployment's one read of the day is taken by someone else
  const lim2 = limiter()
  const busyEnv = { ...ENV, DAZL_TRIAL_SITE_READS_PER_DAY: '1' }
  const other = await user(db, uid(40), 'b3b-o@gmail.com'), c = await user(db, uid(41), 'b3b@gmail.com')
  assert.equal((await admitTrialSiteRead(db, other, '203.0.113.40', { env: busyEnv, limit: lim2 })).ok, true)
  for (let i = 0; i < 3; i++) assert.deepEqual(await admitTrialSiteRead(db, c, '203.0.113.41', { env: busyEnv, limit: lim2 }), { ok: false, reason: 'site_reads_busy' })
  assert.equal(lim2.counts.get(`trial-site:${c.id}`) ?? 0, 0, 'busy refusals: the account\'s reads untouched')
  lim2.counts.delete('trial-site-day:all') // the next day
  assert.equal((await admitTrialSiteRead(db, c, '203.0.113.41', { env: busyEnv, limit: lim2 })).ok, true)
})

bothEngines('probe B8: the daily ceiling is a plain positive integer or the read is off', async () => {
  for (const v of ['0', '', ' ', 'abc', '-1', '2.5', '1_000', 'Infinity', '1e1', '0x5', '5.0', '9007199254740993', undefined]) assert.equal(trialSiteReadsPerDay({ DAZL_TRIAL_SITE_READS_PER_DAY: v }), null, JSON.stringify(v))
  assert.equal(trialSiteReadsPerDay({ DAZL_TRIAL_SITE_READS_PER_DAY: ' 5 ' }), 5)
  assert.equal(trialSiteReadsPerDay({ DAZL_TRIAL_SITE_READS_PER_DAY: '50' }), 50)
})
