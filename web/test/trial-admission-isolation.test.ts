// #409 admission isolation (reviewer fix contract, 2026-11-04): funded website reads and trial scans are scopable
// independently, each default OFF. Before: a read needed the full trial-scan config (trialCaps), and that same config
// admits trial scans for EVERY eligible account, so one allowlisted QA read could not be enabled without opening trial
// scans to the public. Now a read is gated by the wallet's money ceilings (trialWalletCaps) plus its own gates; a scan
// still needs all of trialCaps. Every test runs the ACTUAL admission paths (admitTrialSiteRead, admitTrialScan), on both
// engines. Synthetic accounts, a stubbed limiter; no provider call, no fetch, no spend.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, settleTrialSiteRead, trialCaps, trialFundable, trialRefusal, trialWalletCaps } from '../lib/billing/trial-budget.ts'
import { admitTrialSiteRead } from '../lib/scan/trial-site-read.ts'
import { bothEngines } from './helpers/engines.ts'

const OP = 'sk-ant-api03-ISOLATIONISOLATIONISOLATIONISOLA'
// What an operator sets for ONE allowlisted QA read, and nothing more: the operator key, the read's daily ceiling, the
// allowlist, and the two money ceilings. No per-scan reserve, no TinyFish: trial scans must stay off.
const READ_ONLY_ENV: Record<string, string | undefined> = {
  DAZL_TRIAL_ANTHROPIC_KEY: OP, DAZL_TRIAL_SITE_READS_PER_DAY: '5', DAZL_TRIAL_SITE_READ_ALLOWLIST: 'qa@gmail.com,qa2@gmail.com,qa3@gmail.com',
  DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
}
// The full trial-scan config on top (fixture prices, not vendor worst case).
const SCAN_ENV = { ...READ_ONLY_ENV, DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' }

const user = async (db: Db, id: string, email: string) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
const uid = (n: number) => n.toString(16).padStart(32, '0')
const limiter = () => {
  const n = new Map<string, number>()
  return async (key: string, max: number) => { const c = (n.get(key) ?? 0) + 1; n.set(key, c); return { ok: c <= max, retryAfterS: 60 } }
}
// readTrialStatus reads the operator key from the process environment.
const withKey = async (fn: () => Promise<void>) => {
  const was = process.env.DAZL_TRIAL_ANTHROPIC_KEY
  process.env.DAZL_TRIAL_ANTHROPIC_KEY = OP
  try { await fn() } finally { if (was === undefined) delete process.env.DAZL_TRIAL_ANTHROPIC_KEY; else process.env.DAZL_TRIAL_ANTHROPIC_KEY = was }
}

bothEngines('#409 isolation: an allowlisted read is admitted with trial scans OFF for every account, the read account included', async ({ db }) => {
  await withKey(async () => {
    assert.equal(trialCaps(READ_ONLY_ENV), null, 'no scan config')
    assert.equal(trialFundable(READ_ONLY_ENV as NodeJS.ProcessEnv), false, 'sign-up copy and product truth: no free trial scans')
    assert.deepEqual(trialWalletCaps(READ_ONLY_ENV), { accountTotalUsd: 1, globalDailyUsd: 10 })
    const qa = await user(db, uid(9001), 'qa@gmail.com'), pub = await user(db, uid(9002), 'public@gmail.com')
    const read = await admitTrialSiteRead(db, qa, '203.0.113.1', { env: READ_ONLY_ENV, limit: limiter() })
    assert.ok(read.ok, `the allowlisted read is admitted: ${JSON.stringify(read)}`)
    if (read.ok) await read.settle(0.01)
    // The public signup: no read (not listed), and no trial scan either.
    assert.deepEqual(await admitTrialSiteRead(db, pub, '203.0.113.2', { env: READ_ONLY_ENV, limit: limiter() }), { ok: false, reason: 'not_in_allowlist' })
    assert.deepEqual(await admitTrialScan(db, pub, { env: READ_ONLY_ENV }), { ok: false, reason: 'not_configured' }, 'a read allowlist never funds a public trial scan')
    assert.equal(await trialRefusal(db, pub, { env: READ_ONLY_ENV }), 'not_configured', 'the free-scans counter agrees')
    assert.deepEqual(await admitTrialScan(db, qa, { env: READ_ONLY_ENV }), { ok: false, reason: 'not_configured' }, 'the read account gets no trial scan either')
    // Nothing but the one read is in the wallet.
    const rows = await db.all<{ kind: string; tenant_id: string }>('SELECT kind, tenant_id FROM trial_reservations')
    assert.deepEqual(rows.map(r => [r.kind, r.tenant_id]), [['site_read', qa.id]])
  })
})

bothEngines('#409 isolation: each kind defaults OFF; a read needs both money ceilings, a scan needs its own config too', async ({ db }) => {
  await withKey(async () => {
    const qa = await user(db, uid(9010), 'qa@gmail.com')
    for (const k of ['DAZL_TRIAL_ACCOUNT_TOTAL_USD', 'DAZL_TRIAL_GLOBAL_DAILY_USD'] as const) {
      for (const v of [undefined, '', '0', '-1', 'abc']) {
        const env = { ...READ_ONLY_ENV, [k]: v }
        assert.equal(trialWalletCaps(env), null, `${k}=${v}`)
        assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.3', { env, limit: limiter() }), { ok: false, reason: 'not_configured' }, `read off with ${k}=${v}`)
        assert.equal(await trialRefusal(db, qa, { env, kind: 'site_read' }), 'not_configured')
      }
    }
    // Missing operator key: off for both kinds whatever else is set.
    assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.3', { env: { ...SCAN_ENV, DAZL_TRIAL_ANTHROPIC_KEY: '' }, limit: limiter() }), { ok: false, reason: 'not_configured' })
    assert.equal(trialFundable({ ...SCAN_ENV, DAZL_TRIAL_ANTHROPIC_KEY: '' } as NodeJS.ProcessEnv), false)
    // Scan config without the read gates: scans on, reads still off (no ceiling / no allowlist).
    const noReads = { ...SCAN_ENV, DAZL_TRIAL_SITE_READS_PER_DAY: undefined }
    assert.equal(trialCaps(noReads) !== null, true)
    assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.3', { env: noReads, limit: limiter() }), { ok: false, reason: 'not_configured' })
    assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.3', { env: { ...SCAN_ENV, DAZL_TRIAL_SITE_READ_ALLOWLIST: undefined }, limit: limiter() }), { ok: false, reason: 'not_in_allowlist' })
    // Nothing was reserved by any refusal.
    assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trial_reservations'))!.n), 0)
  })
})

bothEngines('#409 isolation: the day ceiling holds across tenants on the real admission path, pending and failed reads included', async ({ db }) => {
  await withKey(async () => {
    // Room for exactly two $0.05 reads a day across the whole deployment.
    const env = { ...READ_ONLY_ENV, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.10' }
    const a = await user(db, uid(9020), 'qa@gmail.com'), b = await user(db, uid(9021), 'qa2@gmail.com'), c = await user(db, uid(9022), 'qa3@gmail.com')
    const pending = await admitTrialSiteRead(db, a, '203.0.113.20', { env, limit: limiter() })
    assert.ok(pending.ok, 'A: admitted and never settled (its call is still running)')
    const failed = await admitTrialSiteRead(db, b, '203.0.113.21', { env, limit: limiter() })
    assert.ok(failed.ok, 'B: admitted')
    if (failed.ok) await failed.settle(null) // the call failed: it ends at its full reserve
    // C: the pending and the failed read of two OTHER tenants fill the day; C is refused, and nothing of C's is held.
    assert.deepEqual(await admitTrialSiteRead(db, c, '203.0.113.22', { env, limit: limiter() }), { ok: false, reason: 'global_daily_cap' })
    assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trial_reservations WHERE tenant_id = ?', [c.id]))!.n), 0)
  })
})

bothEngines("#409 isolation: one tenant's reservations never leak into another tenant's account ceiling", async ({ db }) => {
  await withKey(async () => {
    // One read's reserve is the whole account total.
    const env = { ...READ_ONLY_ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.05' }
    const a = await user(db, uid(9030), 'qa@gmail.com'), b = await user(db, uid(9031), 'qa2@gmail.com')
    const first = await admitTrialSiteRead(db, a, '203.0.113.30', { env, limit: limiter() })
    assert.ok(first.ok)
    assert.deepEqual(await admitTrialSiteRead(db, a, '203.0.113.30', { env, limit: limiter() }), { ok: false, reason: 'account_total_cap' }, 'A: its pending read holds its whole account')
    const other = await admitTrialSiteRead(db, b, '203.0.113.31', { env, limit: limiter() })
    assert.ok(other.ok, "B: A's reservation is not B's money")
    // A's read settles cheaper: A has room again; B is unaffected.
    if (first.ok) await settleTrialSiteRead(db, a.id, (await db.get<{ id: string }>("SELECT id FROM trial_reservations WHERE tenant_id = ?", [a.id]))!.id, 0)
    assert.equal(await trialRefusal(db, a, { env, kind: 'site_read' }), null)
    assert.equal(await trialRefusal(db, b, { env, kind: 'site_read' }), 'account_total_cap', "B's own pending read holds B's account")
  })
})

bothEngines('#409 isolation: the shared attempts counter is scans only; reads never use one, but an account out of scan attempts gets no funded read', async ({ db }) => {
  await withKey(async () => {
    const wide = { ...SCAN_ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100', DAZL_TRIAL_GLOBAL_DAILY_USD: '100' }
    const r = await user(db, uid(9040), 'qa@gmail.com')
    for (let i = 0; i < 3; i++) assert.equal((await admitTrialSiteRead(db, r, `203.0.113.${40 + i}`, { env: wide, limit: limiter() })).ok, true, `read ${i + 1}`)
    for (let i = 0; i < 3; i++) assert.equal((await admitTrialScan(db, r, { env: wide })).ok, true, `three reads used no scan attempt: scan ${i + 1}`)
    assert.deepEqual(await admitTrialScan(db, r, { env: wide }), { ok: false, reason: 'attempts_cap' })
    // Out of scan attempts: the exhausted trial refuses a read too, on either config (the wallet-only one included).
    const s = await user(db, uid(9041), 'qa2@gmail.com')
    for (let i = 0; i < 3; i++) assert.equal((await admitTrialScan(db, s, { env: wide })).ok, true)
    assert.deepEqual(await admitTrialSiteRead(db, s, '203.0.113.49', { env: wide, limit: limiter() }), { ok: false, reason: 'attempts_cap' })
    assert.deepEqual(await admitTrialSiteRead(db, s, '203.0.113.49', { env: { ...READ_ONLY_ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }, limit: limiter() }), { ok: false, reason: 'attempts_cap' }, 'scans off now, but the attempts already spent still count')
  })
})
