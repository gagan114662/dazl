// #409: an account without its own AI key may have its website read on dazl's trial key, bounded and admitted per read
// (lib/scan/trial-site-read.ts). Synthetic accounts, a stubbed limiter; no provider call, no fetch.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, admitTrialSiteReadBudget, settleTrialSiteRead, trialPrincipal, trialRefusal, READ_GRACE_S, TRIAL_SITE_READ_RESERVE_USD, utcDay } from '../lib/billing/trial-budget.ts'
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

// Council R2-1 on d6c89bf2: a read whose call failed or reported nothing was never settled, and an unsettled read counted
// toward EVERY later day's global ceiling (ledger: one $0.05 read from day D showed on D+1, D+30, D+300), so a provider
// outage or an unpriceable operator model ate reads-per-day x $0.05 of the daily cap for good. Now: a failed call settles
// AT its reserve (null) and ends; a read that never settles (crash) ends for the day ceiling READ_GRACE_S after admission.
// Either way the account keeps paying the reserve.
bothEngines('#444 R2-1: a failed read ends at its reserve and a never-settled read expires for the day ceiling; the account keeps paying the reserve', async ({ db }) => {
  const NOW = 1_800_000_000, DAY = utcDay(NOW), dayStart = DAY * 86400
  // The global day ceiling is exactly one scan reserve: any read still counting today refuses the scan.
  const env = { ...wallet('10', '0.30'), DAZL_TRIAL_SCAN_RESERVE_USD: '0.30' }
  const a = await user(db, uid(470), 'r21a@gmail.com'), probe = await user(db, uid(471), 'r21p@gmail.com')
  // 1. Admitted at day D and never settled (the process died). Same day: counts. D+2: no longer counts toward the day.
  const dead = await admitTrialSiteReadBudget(db, a, { env, now: NOW })
  assert.ok(dead.ok)
  assert.equal(await trialRefusal(db, probe, { env, now: NOW }), 'global_daily_cap', 'day D: the pending read counts')
  assert.equal(await trialRefusal(db, probe, { env, now: NOW + READ_GRACE_S - 1 }), 'global_daily_cap', 'within the grace window: still counts')
  assert.equal(await trialRefusal(db, probe, { env, now: dayStart + 2 * 86400 + 60 }), null, 'D+2: a never-settled read no longer eats the day ceiling')
  // ... but it stays on the account at its full reserve for good.
  assert.deepEqual(await admitTrialScan(db, a, { env: { ...wallet('0.34', '10'), DAZL_TRIAL_SCAN_RESERVE_USD: '0.30' }, now: dayStart + 400 * 86400 }), { ok: false, reason: 'account_total_cap' }, '$0.05 + $0.30 > $0.34 on day D+400')
  // 2. A read admitted late on D whose call fails: settled with null at its reserve, with a timestamp. It counts on D
  //    (admitted) and on the day it ended, never after.
  const b = await user(db, uid(472), 'r21b@gmail.com'), probe2 = await user(db, uid(473), 'r21q@gmail.com')
  const lastSecond = dayStart + 86400 - 1, next = dayStart + 86400 + 60
  const failed = await admitTrialSiteReadBudget(db, b, { env, now: lastSecond })
  assert.ok(failed.ok)
  if (failed.ok) await settleTrialSiteRead(db, b.id, failed.reservation, null, next)
  const row = await db.get<{ settled_at: number; spent_usd: number }>('SELECT settled_at, spent_usd FROM trial_reservations WHERE id = ?', [failed.ok ? failed.reservation : ''])
  assert.deepEqual([Number(row!.settled_at), Number(row!.spent_usd)], [next, TRIAL_SITE_READ_RESERVE_USD], 'settled now, at the full reserve')
  assert.equal(await trialRefusal(db, probe2, { env, now: next + 10 }), 'global_daily_cap', 'ended on D+1: counts toward D+1')
  assert.equal(await trialRefusal(db, probe2, { env, now: dayStart + 2 * 86400 + 60 }), null, 'D+2: a failed read no longer counts')
  assert.deepEqual(await admitTrialScan(db, b, { env: { ...wallet('0.34', '10'), DAZL_TRIAL_SCAN_RESERVE_USD: '0.30' }, now: dayStart + 2 * 86400 + 60 }), { ok: false, reason: 'account_total_cap' }, 'the account still pays the reserve')
})

// Council R2-2 on d6c89bf2: the account's three reads per 30 days were counted first, so three refusals further down
// (deployment busy, network throttle, wallet) burned them with no read done. Now they are counted last, only for a read
// everything else admitted, and a read refused there gives its wallet reservation back.
bothEngines('#444 R2-2: refusals for busy, throttle or money never use one of the account\'s reads; the account count is last and releases the wallet when it refuses', async ({ db }) => {
  await withKey(OP, async () => {
    const a = await user(db, uid(480), 'r22a@gmail.com')
    // A limiter whose deployment ceiling is full for the first three calls, then has room; it records every key counted.
    const counted: string[] = []
    let busy = 3
    const lim = async (key: string, max: number) => {
      counted.push(key)
      if (key === 'trial-site-day:all') return busy-- > 0 ? { ok: false, retryAfterS: 60 } : { ok: true, retryAfterS: 0 }
      const n = counted.filter(k => k === key).length
      return { ok: n <= max, retryAfterS: 60 }
    }
    for (let i = 0; i < 3; i++) assert.deepEqual(await admitTrialSiteRead(db, a, '203.0.113.90', { env: ENV, limit: lim }), { ok: false, reason: 'site_reads_busy' })
    assert.equal(counted.filter(k => k === `trial-site:${a.id}`).length, 0, 'three busy refusals: the account\'s own reads untouched')
    assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trial_reservations WHERE tenant_id = ?', [a.id]))!.n), 0, 'nothing reserved for a refused read')
    assert.equal((await admitTrialSiteRead(db, a, '203.0.113.90', { env: ENV, limit: lim })).ok, true, 'room again: admitted, and only now counted')
    assert.equal(counted.filter(k => k === `trial-site:${a.id}`).length, 1)
    // The wallet refuses (account total too small for a read): the account count is never reached.
    const poor = await user(db, uid(481), 'r22p@gmail.com')
    assert.deepEqual(await admitTrialSiteRead(db, poor, '203.0.113.91', { env: { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.01' }, limit: lim }), { ok: false, reason: 'account_total_cap' })
    assert.equal(counted.filter(k => k === `trial-site:${poor.id}`).length, 0, 'no money: the account\'s reads untouched')
    // The account count itself refusing (three admitted reads already) gives the wallet reservation back.
    const full = await user(db, uid(482), 'r22f@gmail.com')
    for (let i = 0; i < TRIAL_SITE_READS_PER_ACCOUNT; i++) assert.equal((await admitTrialSiteRead(db, full, '203.0.113.92', { env: ENV, limit: lim })).ok, true)
    assert.deepEqual(await admitTrialSiteRead(db, full, '203.0.113.92', { env: ENV, limit: lim }), { ok: false, reason: 'site_reads_used' })
    assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trial_reservations WHERE tenant_id = ?', [full.id]))!.n), TRIAL_SITE_READS_PER_ACCOUNT, 'the refused fourth read left no reservation behind')
  })
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
