// #409: an account without its own AI key may have its website read on dazl's trial key, bounded and admitted per read
// (lib/scan/trial-site-read.ts). Synthetic accounts, a stubbed limiter; no provider call, no fetch.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, admitTrialSiteReadBudget, settleTrialSiteRead, trialPrincipal, TRIAL_SITE_READ_RESERVE_USD, utcDay } from '../lib/billing/trial-budget.ts'
import { admitTrialSiteRead, admitWorkspaceSiteRead, trialSiteReadsPerDay, TRIAL_SITE_READS_PER_ACCOUNT, TRIAL_SITE_READS_PER_IP_PER_DAY } from '../lib/scan/trial-site-read.ts'
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
    const ok = await admitTrialSiteRead(db, a, '203.0.113.9', { env: ENV, limit: limiter() })
    assert.ok(ok.ok && ok.key.key === OP && ok.key.vendor === 'anthropic' && typeof ok.settle === 'function', JSON.stringify(ok))
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

// Instinct's hold on 7057370: a trial-funded site read is paid work, so it reserves its maximum cost in the same wallet
// (trial_reservations, under trial_budget_lock) as trial scans, and counts toward the account-total and daily-global
// money ceilings, pending or not, across midnight.
const wallet = (account: string, daily: string) => ({ ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: account, DAZL_TRIAL_GLOBAL_DAILY_USD: daily, DAZL_TRIAL_SITE_READS_PER_DAY: '1000' })

bothEngines('#409 wallet: an admitted site read leaves too little room for a full scan (Instinct negative)', async ({ db }) => {
  await withKey(OP, async () => {
    const a = await user(db, uid(400), 'w@gmail.com')
    const env = wallet('0.30', '0.30') // scan reserve $0.30: one scan exactly fits an empty wallet
    assert.equal((await admitTrialSiteRead(db, a, '203.0.113.60', { env, limit: limiter() })).ok, true)
    assert.deepEqual(await admitTrialScan(db, a, { env }), { ok: false, reason: 'account_total_cap' }, 'the read holds $0.05 of the $0.30')
    // Another account the same day: the daily-global room is also reduced by the read.
    const b = await user(db, uid(401), 'x@gmail.com')
    assert.deepEqual(await admitTrialScan(db, b, { env: wallet('1', '0.30') }), { ok: false, reason: 'global_daily_cap' })
  })
})

bothEngines('#409 wallet: concurrent read/read and read/scan at a boundary admit only what fits', async ({ db }) => {
  await withKey(OP, async () => {
    // read/read: the day has room for exactly one read ($0.05) beside nothing else.
    const env = wallet('1', '0.07')
    const r = await Promise.all([0, 1, 2, 3].map(async i => admitTrialSiteRead(db, await user(db, uid(410 + i), `rr${i}@gmail.com`), `198.51.100.${10 + i}`, { env, limit: limiter() })))
    assert.equal(r.filter(x => x.ok).length, 1, JSON.stringify(r))
    assert.ok(r.filter(x => !x.ok).every(x => !x.ok && x.reason === 'global_daily_cap'))
  })
})

bothEngines('#409 wallet: read/scan for one account at the account boundary: one of the two, never both', async ({ db }) => {
  await withKey(OP, async () => {
    const a = await user(db, uid(420), 'rs@gmail.com')
    const env = wallet('0.32', '10') // a read ($0.05) and a scan ($0.30) do not both fit $0.32
    const [read, scan] = await Promise.all([admitTrialSiteRead(db, a, '203.0.113.70', { env, limit: limiter() }), admitTrialScan(db, a, { env })])
    assert.equal(Number(read.ok) + Number(scan.ok), 1, JSON.stringify([read, scan]))
  })
})

bothEngines('#409 wallet: a read counts its full reserve until it settles to the reported cost; it is never a scan attempt', async ({ db }) => {
  await withKey(OP, async () => {
    const a = await user(db, uid(430), 'st@gmail.com')
    const env = wallet('0.32', '10')
    const read = await admitTrialSiteRead(db, a, '203.0.113.80', { env, limit: limiter() })
    assert.ok(read.ok)
    assert.deepEqual(await admitTrialScan(db, a, { env }), { ok: false, reason: 'account_total_cap' }, 'pending read: full $0.05 reserve')
    if (read.ok) await read.settle(0.01)
    assert.equal((await admitTrialScan(db, a, { env })).ok, true, 'settled at $0.01: the $0.30 scan fits $0.32')
    // Three reads use no scan attempt: the account still has its three scans (wide money ceilings).
    const b = await user(db, uid(431), 'at@gmail.com'), wide = wallet('100', '100')
    for (let i = 0; i < 3; i++) assert.equal((await admitTrialSiteRead(db, b, `203.0.113.${90 + i}`, { env: wide, limit: limiter() })).ok, true)
    for (let i = 0; i < 3; i++) assert.equal((await admitTrialScan(db, b, { env: wide })).ok, true, `scan ${i + 1}`)
    assert.deepEqual(await admitTrialScan(db, b, { env: wide }), { ok: false, reason: 'attempts_cap' })
  })
})

bothEngines('#409 wallet: across midnight a pending read counts toward both days; one settled before midnight does not', async ({ db }) => {
  const NOW = 1_800_000_000, DAY = utcDay(NOW), lastSecond = (DAY + 1) * 86400 - 1, next = (DAY + 1) * 86400 + 60
  const env = wallet('10', '0.30')
  const a = await user(db, uid(440), 'mn1@gmail.com'), b = await user(db, uid(441), 'mn2@gmail.com'), c = await user(db, uid(442), 'mn3@gmail.com')
  const pending = await admitTrialSiteReadBudget(db, a, { env, now: lastSecond })
  assert.ok(pending.ok)
  assert.deepEqual(await admitTrialScan(db, b, { env, now: next }), { ok: false, reason: 'global_daily_cap' }, 'unsettled read from yesterday still counts today')
  if (pending.ok) await settleTrialSiteRead(db, a.id, pending.reservation, 0.02, lastSecond)
  assert.equal((await admitTrialScan(db, c, { env, now: next })).ok, true, 'settled before midnight: not today')
  assert.equal(TRIAL_SITE_READ_RESERVE_USD, 0.05)
})

// Instinct's hold on 8cfcf7d: the read's reserve is dazl's own bound, not a vendor-enforced maximum. A reported cost
// above it is what was spent, and later work is refused against it; a missing or unusable cost keeps the full reserve.
bothEngines('#409 wallet: a reported read cost above its reserve counts in full (Instinct negative); unusable costs keep the reserve', async ({ db }) => {
  const env = { ...wallet('0.30', '0.30'), DAZL_TRIAL_SCAN_RESERVE_USD: '0.25' }
  const a = await user(db, uid(450), 'ov@gmail.com')
  const read = await admitTrialSiteReadBudget(db, a, { env })
  assert.ok(read.ok)
  if (read.ok) await settleTrialSiteRead(db, a.id, read.reservation, 0.08)
  assert.deepEqual(await admitTrialScan(db, a, { env }), { ok: false, reason: 'account_total_cap' }, 'reported $0.08 + scan $0.25 > $0.30')
  // NaN, Infinity or a negative cost is not a cost: the read keeps counting its full $0.05.
  for (const [i, bad] of [NaN, Infinity, -0.01].entries()) {
    const b = await user(db, uid(460 + i), `bad${i}@gmail.com`)
    const r = await admitTrialSiteReadBudget(db, b, { env: wallet('0.30', '10') })
    assert.ok(r.ok)
    if (r.ok) await settleTrialSiteRead(db, b.id, r.reservation, bad)
    assert.deepEqual(await admitTrialScan(db, b, { env: { ...wallet('0.30', '10'), DAZL_TRIAL_SCAN_RESERVE_USD: '0.26' } }), { ok: false, reason: 'account_total_cap' }, `${bad}: $0.05 + $0.26 > $0.30`)
  }
})

bothEngines('#444 the trial principal is the workspace founder\'s account, read on the server, only while it acts; otherwise none', async ({ db }) => {
  await withKey(OP, async () => {
    const owner = await user(db, uid(900), 'Owner@Corp.example')
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [owner.id, owner.id])
    const me = { tenantId: owner.id, actorId: owner.id }
    assert.deepEqual(await trialPrincipal(db, me), { id: owner.id, email: 'Owner@Corp.example' })
    assert.equal(await trialPrincipal(db, { tenantId: owner.id, actorId: uid(950) }), null, 'another member acting: none')
    // a personal workspace whose founder row is missing; one whose created_by is someone else; a team workspace; an
    // unknown id: no principal, refused
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [uid(901), uid(901)])
    const other = await user(db, uid(904), 'x@else.example')
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [other.id, owner.id])
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'T', 'team', ?, 1)", [uid(902), owner.id])
    for (const id of [uid(901), other.id, uid(902), uid(903)]) {
      assert.equal(await trialPrincipal(db, { tenantId: id, actorId: id }), null, id)
      assert.deepEqual(await admitWorkspaceSiteRead(db, { tenantId: id, actorId: id }, '203.0.113.200', { env: ENV, limit: limiter() }), { ok: false, reason: 'workspace_not_eligible' })
    }
    assert.deepEqual(await admitWorkspaceSiteRead(db, { tenantId: owner.id, actorId: uid(950) }, '203.0.113.202', { env: ENV, limit: limiter() }), { ok: false, reason: 'workspace_not_eligible' })
    assert.equal((await admitWorkspaceSiteRead(db, me, '203.0.113.201', { env: ENV, limit: limiter() })).ok, true, 'the founder acting: admitted')
  })
})
