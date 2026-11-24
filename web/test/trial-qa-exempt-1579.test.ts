// #1579: the operator switch DAZL_TRIAL_QA_EXEMPT names the acceptance tester's account, which the limits that count one account or
// one network do not stop (Google sign-in, one trial per company domain, scan attempts, the account's dollar total, a password
// account's one-scan allowance, the per-network scans per day, three website reads per 30 days, the per-network reads per day, the
// website-read allowlist). Pinned here with real admissions on a real store: each of those states admits a listed account and refuses
// an unlisted one exactly as before; the global daily ceiling, the deployment's reads per day, a missing configuration and an
// unconfirmed address still refuse a listed account; every admission still writes its reservation; unset means unchanged.
// The monthly plan quota and the route's own first check are pinned through the real POST /api/scan (test/trial-attempts-route.test.ts).
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, admitTrialSiteReadBudget, linkTrialReservation, PASSWORD_TRIAL_SCANS, trialAllowanceLeft, trialQaExempt, trialRefusal, trialScanAllowance } from '../lib/billing/trial-budget.ts'
import { ipHash, readTrialStatus, trialStatus, TRIAL_SCANS_PER_ACCOUNT, TRIAL_SCANS_PER_IP_PER_DAY } from '../lib/scan/trial.ts'
import { admitTrialSiteRead, TRIAL_SITE_READS_PER_ACCOUNT, TRIAL_SITE_READS_PER_IP_PER_DAY } from '../lib/scan/trial-site-read.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = Math.floor(Date.now() / 1000)
const ENV: Record<string, string> = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-fixture-operator', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  DAZL_TRIAL_SITE_READS_PER_DAY: '50', DAZL_TRIAL_SITE_READ_ALLOWLIST: 'public' }
// invented accounts, each on its own invented company domain (so the one-trial-per-domain rule never stands in for the limit under
// test); a wildcard entry and an entry with no @ are in the list on purpose: both are ignored
const LIST = ' Quest@Acme.example , qa@attempts.example,qa@total.example,qa@pw.example,qa@unconfirmed.example,*@wild.example,wild.example,'
const QA: Record<string, string> = { ...ENV, DAZL_TRIAL_QA_EXEMPT: LIST }
const penv = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv

let n = 0
const user = async (db: Db, email: string, o: { verified?: boolean; google?: boolean } = {}) => {
  const id = (++n).toString(16).padStart(32, '0')
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, email_verified_at) VALUES (?, ?, 'n', 'b', 'x', 'y', ?)", [id, email, o.verified === false ? null : NOW - 60])
  if (o.google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
type U = { id: string; email: string }
const scan = (db: Db, u: U, env: Record<string, string>) => admitTrialScan(db, u, { env, now: NOW })
const read = (db: Db, u: U, env: Record<string, string>) => admitTrialSiteReadBudget(db, u, { env, now: NOW })
// the scan an admission paid for, as POST /api/scan leaves it while it runs: the job, the linked reservation, the counter row
const run = async (db: Db, u: U, a: Awaited<ReturnType<typeof admitTrialScan>>, ip = '203.0.113.1') => {
  assert.ok(a.ok, JSON.stringify(a))
  const id = `job${String(++n).padStart(21, '0')}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, ?, 'b', 'i', 'l', 'running', ?)", [id, u.id, NOW])
  await linkTrialReservation(db, u.id, a.reservation, id)
  await db.run('INSERT INTO trial_scans (tenant_id, job_id, ip_hash, created_at) VALUES (?, ?, ?, ?)', [u.id, id, ipHash(ip), NOW])
}
const reservations = async (db: Db, u: U) => Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM trial_reservations WHERE tenant_id = ?', [u.id]))!.n)
// the shared limiter, in memory: one count per key
const limiter = () => {
  const counts = new Map<string, number>()
  return async (key: string, max: number) => { const c = (counts.get(key) ?? 0) + 1; counts.set(key, c); return { ok: c <= max, retryAfterS: 60 } }
}

bothEngines('#1579 the list: exact addresses only; unset, empty, a wildcard, an entry with no @ and a +tag or dotted variant name nobody', async () => {
  assert.equal(trialQaExempt('quest@acme.example', {}), false, 'unset')
  assert.equal(trialQaExempt('quest@acme.example', { DAZL_TRIAL_QA_EXEMPT: ' , ' }), false, 'empty')
  assert.equal(trialQaExempt(' QUEST@acme.example ', QA), true, 'case and spaces do not matter')
  assert.equal(trialQaExempt('someone@acme.example', QA), false, 'another address on the same domain')
  assert.equal(trialQaExempt('anyone@wild.example', QA), false, 'a wildcard entry is ignored')
  assert.equal(trialQaExempt('wild.example', QA), false, 'an entry with no @ is ignored')
  assert.equal(trialQaExempt('*@wild.example', QA), false, 'the wildcard entry does not even name itself')
  assert.equal(trialQaExempt('', QA), false)
  // exact: listing one address exempts that one account, not the others its mailbox could receive for
  assert.equal(trialQaExempt('quest+check@acme.example', QA), false, 'a +tag variant of a listed address is NOT exempt')
  const dotted = { DAZL_TRIAL_QA_EXEMPT: 'invented.tester@gmail.com' }
  assert.equal(trialQaExempt('invented.tester@gmail.com', dotted), true)
  for (const variant of ['inventedtester@gmail.com', 'invented.tester+x@gmail.com', 'invented.tester@googlemail.com'])
    assert.equal(trialQaExempt(variant, dotted), false, `${variant} is another account`)
})

bothEngines('#1579 a +tag account of a listed address is refused like any unlisted account', async ({ db }) => {
  const env = { ...QA, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }
  const tagged = await user(db, 'qa+two@attempts.example', { google: true })
  for (let i = 0; i < TRIAL_SCANS_PER_ACCOUNT; i++) await run(db, tagged, await scan(db, tagged, env))
  assert.deepEqual(await scan(db, tagged, env), { ok: false, reason: 'attempts_cap' })
  assert.deepEqual(await read(db, tagged, env), { ok: false, reason: 'attempts_cap' })
})

bothEngines('#1579 used attempts: the listed account is admitted for a search and a website read; an unlisted one is refused as before', async ({ db }) => {
  const env = { ...QA, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }, off = { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }
  const qa = await user(db, 'qa@attempts.example', { google: true }), other = await user(db, 'pat@attempts-other.example', { google: true })
  for (const u of [qa, other]) for (let i = 0; i < TRIAL_SCANS_PER_ACCOUNT; i++) await run(db, u, await scan(db, u, env))
  assert.deepEqual(await scan(db, other, env), { ok: false, reason: 'attempts_cap' })
  assert.deepEqual(await read(db, other, env), { ok: false, reason: 'attempts_cap' })
  assert.equal(await trialRefusal(db, other, { env, now: NOW }), 'attempts_cap')
  // the same account, the switch unset: exactly what it was
  assert.deepEqual(await scan(db, qa, off), { ok: false, reason: 'attempts_cap' })
  assert.deepEqual(await read(db, qa, off), { ok: false, reason: 'attempts_cap' })
  assert.equal(await trialRefusal(db, qa, { env, now: NOW }), null)
  assert.equal(await trialRefusal(db, qa, { env, now: NOW, kind: 'site_read' }), null)
  const before = await reservations(db, qa)
  await run(db, qa, await scan(db, qa, env))
  assert.equal((await read(db, qa, env)).ok, true)
  assert.equal(await reservations(db, qa), before + 2, 'each admission still reserves in the ledger')
})

bothEngines('#1579 account total reached: the listed account is admitted; an unlisted one is refused as before', async ({ db }) => {
  const env = { ...QA, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.32' }, off = { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.32' }
  const qa = await user(db, 'qa@total.example', { google: true }), other = await user(db, 'pat@total-other.example', { google: true })
  for (const u of [qa, other]) await run(db, u, await scan(db, u, env))
  assert.deepEqual(await scan(db, other, env), { ok: false, reason: 'account_total_cap' })
  assert.deepEqual(await read(db, other, env), { ok: false, reason: 'account_total_cap' })
  assert.deepEqual(await scan(db, qa, off), { ok: false, reason: 'account_total_cap' })
  assert.deepEqual(await read(db, qa, off), { ok: false, reason: 'account_total_cap' })
  assert.equal((await read(db, qa, env)).ok, true)
  await run(db, qa, await scan(db, qa, env))
  // the dollar line of the cost screen: an unlisted account reads what is left; the listed one has no account total to count down
  assert.deepEqual(await trialAllowanceLeft(db, other.id, { env, now: NOW }), { left_usd: 0.32 - 0.30, total_usd: 0.32 })
  assert.equal(await trialAllowanceLeft(db, qa.id, { env, now: NOW }), null)
  assert.deepEqual(await trialAllowanceLeft(db, qa.id, { env: off, now: NOW }), { left_usd: 0, total_usd: 0.32 })
})

bothEngines('#1579 a used company domain and a password sign-up: the listed account is admitted; unlisted ones are refused as before', async ({ db }) => {
  const first = await user(db, 'ann@acme.example', { google: true })
  await run(db, first, await scan(db, first, QA))
  const quest = await user(db, 'quest@acme.example'), colleague = await user(db, 'bob@acme.example', { google: true })
  assert.deepEqual(await scan(db, colleague, QA), { ok: false, reason: 'domain_used' })
  assert.deepEqual(await read(db, colleague, QA), { ok: false, reason: 'domain_used' })
  assert.deepEqual(await scan(db, quest, ENV), { ok: false, reason: 'domain_used' }, 'unset: unchanged')
  assert.deepEqual(await read(db, quest, ENV), { ok: false, reason: 'domain_used' }, 'unset: unchanged')
  assert.equal((await read(db, quest, QA)).ok, true)
  await run(db, quest, await scan(db, quest, QA))

  // a password account (confirmed address, no Google): one free search for anyone, no such limit for the listed account
  const qa = await user(db, 'qa@pw.example'), other = await user(db, 'pat@pw-other.example')
  for (const u of [qa, other]) for (let i = 0; i < PASSWORD_TRIAL_SCANS; i++) await run(db, u, await scan(db, u, QA))
  assert.deepEqual(await scan(db, other, QA), { ok: false, reason: 'google_required' })
  assert.deepEqual(await read(db, other, QA), { ok: false, reason: 'google_required' })
  assert.deepEqual(await scan(db, qa, ENV), { ok: false, reason: 'google_required' }, 'unset: unchanged')
  assert.equal((await read(db, qa, QA)).ok, true)
  await run(db, qa, await scan(db, qa, QA))
  await run(db, qa, await scan(db, qa, QA))
  assert.equal((await scan(db, qa, QA)).ok, true, 'past the usual three as well')
  // the counter: three shown for the listed account, one for any other password account
  assert.equal(await trialScanAllowance(db, qa.id, QA), TRIAL_SCANS_PER_ACCOUNT)
  assert.equal(await trialScanAllowance(db, qa.id, ENV), PASSWORD_TRIAL_SCANS)
  assert.equal(await trialScanAllowance(db, other.id, QA), PASSWORD_TRIAL_SCANS)
  // a listed address that was never confirmed is still refused, for a search and for a read: the switch does not replace confirmation
  const unconfirmed = await user(db, 'qa@unconfirmed.example', { verified: false })
  assert.deepEqual(await scan(db, unconfirmed, QA), { ok: false, reason: 'google_required' })
  assert.deepEqual(await read(db, unconfirmed, QA), { ok: false, reason: 'google_required' })
})

bothEngines('#1579 the money guard: the global daily ceiling and a missing configuration refuse the listed account like anyone', async ({ db }) => {
  const tight = { ...QA, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.62' }
  const a = await user(db, 'pat@day.example', { google: true }), qa = await user(db, 'qa@pw.example')
  await run(db, a, await scan(db, a, tight))
  await run(db, qa, await scan(db, qa, tight))
  // 0.60 of the day's 0.62 is reserved: nothing more fits, for the listed account either
  assert.deepEqual(await scan(db, qa, tight), { ok: false, reason: 'global_daily_cap' })
  assert.deepEqual(await read(db, qa, tight), { ok: false, reason: 'global_daily_cap' })
  assert.equal(await trialRefusal(db, qa, { env: tight, now: NOW }), 'global_daily_cap')
  assert.equal(await reservations(db, qa), 1, 'a refused admission reserved nothing')
  const total = Number((await db.get<{ s: number }>('SELECT sum(reserve_usd) AS s FROM trial_reservations'))!.s)
  assert.ok(total <= 0.62 + 1e-9, `the day's reservations (${total}) stay inside the ceiling`)
  const unset: Record<string, string> = { ...QA }
  delete unset.DAZL_TRIAL_GLOBAL_DAILY_USD
  assert.deepEqual(await scan(db, qa, unset), { ok: false, reason: 'not_configured' })
  assert.deepEqual(await read(db, qa, unset), { ok: false, reason: 'not_configured' })
})

bothEngines('#1579 the first check and the counter: a listed account past its attempts, on a network at its daily scans, is still funded and shows searches left', async ({ db, raw }) => {
  const env = { ...QA, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100', DAZL_TRIAL_GLOBAL_DAILY_USD: '100' }, off = { ...env, DAZL_TRIAL_QA_EXEMPT: '' }
  const qa = await user(db, 'qa@attempts.example', { google: true }), other = await user(db, 'pat@attempts-other.example', { google: true })
  for (let i = 0; i < TRIAL_SCANS_PER_ACCOUNT + 1; i++) await run(db, qa, await scan(db, qa, env), '203.0.113.1')
  for (let i = 0; i < TRIAL_SCANS_PER_ACCOUNT; i++) await run(db, other, await scan(db, other, env), '203.0.113.2')
  const at = new Date(NOW * 1000)
  const mine = await readTrialStatus(db, qa.id, '198.51.100.7', at, penv(env))
  assert.equal(mine.funded, true)
  assert.equal(mine.remaining, TRIAL_SCANS_PER_ACCOUNT, 'the searches-left counter is not zero')
  for (const s of [await readTrialStatus(db, other.id, '198.51.100.7', at, penv(env)), await readTrialStatus(db, qa.id, '198.51.100.7', at, penv(off))])
    assert.deepEqual([s.funded, s.reason, s.remaining], [false, 'account_cap', 0], 'unlisted, or the switch empty: as before')
  // the per-network scans per day: a network at its nine refuses a fresh unlisted account, not the listed one
  for (let i = 0; i < TRIAL_SCANS_PER_IP_PER_DAY; i++) await db.run('INSERT INTO trial_scans (tenant_id, job_id, ip_hash, created_at) VALUES (?, ?, ?, ?)', [other.id, `none${i}`, ipHash('198.51.100.9'), NOW])
  const fresh = await user(db, 'pat@fresh.example', { google: true })
  assert.equal((await readTrialStatus(db, fresh.id, '198.51.100.9', at, penv(env))).reason, 'ip_throttle')
  assert.deepEqual(await readTrialStatus(db, qa.id, '198.51.100.9', at, penv(env)), { funded: true, used: TRIAL_SCANS_PER_ACCOUNT + 1, remaining: TRIAL_SCANS_PER_ACCOUNT })
  if (raw) {
    // POST /api/scan's own first check reads the same store synchronously
    assert.deepEqual(trialStatus(raw, qa.id, '198.51.100.9', at, penv(env)), { funded: true, used: TRIAL_SCANS_PER_ACCOUNT + 1, remaining: TRIAL_SCANS_PER_ACCOUNT })
    assert.equal(trialStatus(raw, fresh.id, '198.51.100.9', at, penv(env)).reason, 'ip_throttle')
    assert.equal(trialStatus(raw, other.id, '198.51.100.7', at, penv(env)).reason, 'account_cap')
    assert.equal(trialStatus(raw, qa.id, '198.51.100.7', at, penv(off)).reason, 'account_cap')
  }
})

bothEngines('#1579 website reads end to end: the listed account is not held to three reads, its network\'s reads or the allowlist; unlisted accounts are; the daily ceilings stay', async ({ db }) => {
  const limit = limiter()
  const env = { ...QA, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }
  const qa = await user(db, 'qa@attempts.example', { google: true }), other = await user(db, 'pat@reads.example', { google: true })
  for (let i = 0; i < TRIAL_SCANS_PER_ACCOUNT; i++) await run(db, qa, await scan(db, qa, env))
  // the account's own three reads per 30 days
  for (let i = 0; i < TRIAL_SITE_READS_PER_ACCOUNT; i++) {
    assert.equal((await admitTrialSiteRead(db, qa, '203.0.113.21', { env, limit })).ok, true)
    assert.equal((await admitTrialSiteRead(db, other, '203.0.113.22', { env, limit })).ok, true)
  }
  assert.deepEqual(await admitTrialSiteRead(db, other, '203.0.113.22', { env, limit }), { ok: false, reason: 'site_reads_used' })
  assert.equal((await admitTrialSiteRead(db, qa, '203.0.113.21', { env, limit })).ok, true, 'a fourth read, with its scan attempts used as well')
  assert.equal(await reservations(db, qa), TRIAL_SCANS_PER_ACCOUNT + TRIAL_SITE_READS_PER_ACCOUNT + 1, 'every read reserved in the ledger')
  // unset: the same account is refused by the scan count first, as before
  assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.24', { env: { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }, limit }), { ok: false, reason: 'account_cap' })
  // the per-network reads per day: a network at its six refuses the next unlisted account, not the listed one
  let ok = 0, last
  for (let i = 0; i < TRIAL_SITE_READS_PER_IP_PER_DAY + 1; i++) { last = await admitTrialSiteRead(db, await user(db, `pat@net${i}.example`, { google: true }), '192.0.2.7', { env, limit }); if (last.ok) ok++ }
  assert.deepEqual([ok, last], [TRIAL_SITE_READS_PER_IP_PER_DAY, { ok: false, reason: 'ip_throttle' }])
  assert.equal((await admitTrialSiteRead(db, qa, '192.0.2.7', { env, limit })).ok, true)
  // the allowlist, when it is not public: an unlisted account is not on it; the listed account counts as on it
  const listed = { ...env, DAZL_TRIAL_SITE_READ_ALLOWLIST: 'someone@else.example' }, noList: Record<string, string> = { ...env }
  delete noList.DAZL_TRIAL_SITE_READ_ALLOWLIST
  const outsider = await user(db, 'pat@nolist.example', { google: true })
  for (const e of [listed, noList]) {
    assert.deepEqual(await admitTrialSiteRead(db, outsider, '203.0.113.30', { env: e, limit }), { ok: false, reason: 'not_in_allowlist' })
    assert.equal((await admitTrialSiteRead(db, qa, '203.0.113.31', { env: e, limit })).ok, true)
  }
  assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.31', { env: { ...listed, DAZL_TRIAL_QA_EXEMPT: '' }, limit }), { ok: false, reason: 'account_cap' }, 'the switch empty: as before')
  // kept: the deployment's reads per day and the wallet's daily ceiling still stop the listed account
  assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.25', { env: { ...env, DAZL_TRIAL_SITE_READS_PER_DAY: '1' }, limit }), { ok: false, reason: 'site_reads_busy' })
  assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.26', { env: { ...env, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.50' }, limit }), { ok: false, reason: 'global_daily_cap' })
  assert.equal((await admitTrialSiteRead(db, qa, '203.0.113.27', { env: { ...env, DAZL_TRIAL_SITE_READS_PER_DAY: '' }, limit })).ok, false, 'no reads-per-day ceiling set: off for the listed account too')
})
