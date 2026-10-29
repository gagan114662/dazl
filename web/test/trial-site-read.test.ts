// #409: an account without its own AI key may have its website read on dazl's trial key, bounded and admitted per read
// (lib/scan/trial-site-read.ts). Synthetic accounts, a stubbed limiter; no provider call, no fetch.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan } from '../lib/billing/trial-budget.ts'
import { admitTrialSiteRead, trialSiteReadsPerDay, TRIAL_SITE_READS_PER_ACCOUNT, TRIAL_SITE_READS_PER_IP_PER_DAY } from '../lib/scan/trial-site-read.ts'
import { bothEngines } from './helpers/engines.ts'

const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
const ENV = { DAZL_TRIAL_ANTHROPIC_KEY: OP, DAZL_TRIAL_SITE_READS_PER_DAY: '5', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' }
const user = async (db: Db, id: string, email: string, google = true) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  if (google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
const uid = (n: number) => n.toString(16).padStart(32, '0')
// The shared limiter, in memory: counts per key; `down` answers as if the store could not.
const limiter = (down = false) => {
  const n = new Map<string, number>()
  return async (key: string, max: number) => {
    if (down) return { ok: false, retryAfterS: 30, unavailable: true as const }
    const c = (n.get(key) ?? 0) + 1; n.set(key, c)
    return { ok: c <= max, retryAfterS: 60 }
  }
}
// readTrialStatus reads the operator key from the process environment.
const withKey = async (key: string | undefined, fn: () => Promise<void>) => {
  const was = process.env.DAZL_TRIAL_ANTHROPIC_KEY
  if (key === undefined) delete process.env.DAZL_TRIAL_ANTHROPIC_KEY; else process.env.DAZL_TRIAL_ANTHROPIC_KEY = key
  try { await fn() } finally { if (was === undefined) delete process.env.DAZL_TRIAL_ANTHROPIC_KEY; else process.env.DAZL_TRIAL_ANTHROPIC_KEY = was }
}

bothEngines('#409 trial site read: off unless the operator key AND a daily ceiling are set; then admitted with the operator key', async ({ db }) => {
  await withKey(OP, async () => {
    const a = await user(db, uid(1), 'owner@acme.example')
    assert.equal(trialSiteReadsPerDay({}), null)
    assert.equal(trialSiteReadsPerDay({ DAZL_TRIAL_SITE_READS_PER_DAY: '0' }), null)
    assert.equal(trialSiteReadsPerDay({ DAZL_TRIAL_SITE_READS_PER_DAY: '2.5' }), null)
    assert.deepEqual(await admitTrialSiteRead(db, a, '203.0.113.9', { env: { ...ENV, DAZL_TRIAL_SITE_READS_PER_DAY: '' }, limit: limiter() }), { ok: false, reason: 'not_configured' }, 'no explicit daily ceiling: off')
    assert.deepEqual(await admitTrialSiteRead(db, a, '203.0.113.9', { env: { ...ENV, DAZL_TRIAL_ANTHROPIC_KEY: '' }, limit: limiter() }), { ok: false, reason: 'not_configured' })
    assert.deepEqual(await admitTrialSiteRead(db, a, '203.0.113.9', { env: ENV, limit: limiter() }), { ok: true, key: { vendor: 'anthropic', key: OP } })
  })
  await withKey(undefined, async () => {
    // A deployment with no operator key at all (staging): unavailable, whatever else is set.
    assert.deepEqual(await admitTrialSiteRead(db, { id: uid(1), email: 'owner@acme.example' }, '203.0.113.9', { env: { ...ENV, DAZL_TRIAL_ANTHROPIC_KEY: undefined }, limit: limiter() }), { ok: false, reason: 'not_configured' })
  })
})

bothEngines('#409 trial site read: the trial scan rules apply (Google sign-in, one per company domain, exhausted attempts)', async ({ db }) => {
  await withKey(OP, async () => {
    const noGoogle = await user(db, uid(2), 'a@nogoogle.example', false)
    assert.deepEqual(await admitTrialSiteRead(db, noGoogle, '203.0.113.9', { env: ENV, limit: limiter() }), { ok: false, reason: 'google_required' })
    const first = await user(db, uid(3), 'one@samedomain.example'), second = await user(db, uid(4), 'two@samedomain.example')
    assert.equal((await admitTrialScan(db, first, { env: ENV })).ok, true)
    assert.deepEqual(await admitTrialSiteRead(db, second, '203.0.113.9', { env: ENV, limit: limiter() }), { ok: false, reason: 'domain_used' })
    // Three admitted scan attempts (paid failures included) end the trial, site reads too: exhausted budget.
    const used = await user(db, uid(5), 'x@gmail.com')
    for (let i = 0; i < 3; i++) assert.equal((await admitTrialScan(db, used, { env: { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' } })).ok, true)
    assert.deepEqual(await admitTrialSiteRead(db, used, '203.0.113.9', { env: { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }, limit: limiter() }), { ok: false, reason: 'attempts_cap' })
  })
})

bothEngines('#409 trial site read: per-account, per-network and deployment-wide caps; an unavailable limiter refuses', async ({ db }) => {
  await withKey(OP, async () => {
    const a = await user(db, uid(6), 'a@gmail.com')
    const lim = limiter()
    for (let i = 0; i < TRIAL_SITE_READS_PER_ACCOUNT; i++) assert.equal((await admitTrialSiteRead(db, a, '198.51.100.1', { env: ENV, limit: lim })).ok, true)
    assert.deepEqual(await admitTrialSiteRead(db, a, '198.51.100.1', { env: ENV, limit: lim }), { ok: false, reason: 'site_reads_used' })
    // One network: TRIAL_SITE_READS_PER_IP_PER_DAY across accounts (each account fresh), with a high deployment ceiling.
    const net = limiter(), wide = { ...ENV, DAZL_TRIAL_SITE_READS_PER_DAY: '1000' }
    let ok = 0, last
    for (let i = 0; i < TRIAL_SITE_READS_PER_IP_PER_DAY + 1; i++) { last = await admitTrialSiteRead(db, await user(db, uid(100 + i), `n${i}@gmail.com`), '192.0.2.7', { env: wide, limit: net }); if (last.ok) ok++ }
    assert.deepEqual([ok, last], [TRIAL_SITE_READS_PER_IP_PER_DAY, { ok: false, reason: 'ip_throttle' }])
    // The deployment-wide ceiling (5 a day here), across accounts and networks.
    const all = limiter()
    let admittedN = 0, refused
    for (let i = 0; i < 6; i++) { refused = await admitTrialSiteRead(db, await user(db, uid(200 + i), `d${i}@gmail.com`), `203.0.113.${i}`, { env: ENV, limit: all }); if (refused.ok) admittedN++ }
    assert.deepEqual([admittedN, refused], [5, { ok: false, reason: 'site_reads_busy' }])
    assert.deepEqual(await admitTrialSiteRead(db, await user(db, uid(300), 'z@gmail.com'), '203.0.113.50', { env: ENV, limit: limiter(true) }), { ok: false, reason: 'limit_unavailable' })
  })
})
