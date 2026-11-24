// #1579: the operator switch DAZL_TRIAL_QA_EXEMPT names the acceptance tester's account, which the PER-ACCOUNT free-trial limits do
// not stop (Google sign-in, one trial per company domain, scan attempts, the account's dollar total, a password account's one-scan
// allowance, three website reads per 30 days). Pinned here with real admissions on a real store: each of those states admits a
// listed account and refuses an unlisted one exactly as before; the global daily ceiling, a missing configuration and an
// unconfirmed address still refuse a listed account; every admission still writes its reservation; unset means unchanged.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, admitTrialSiteReadBudget, linkTrialReservation, PASSWORD_TRIAL_SCANS, trialAllowanceLeft, trialQaExempt, trialRefusal, trialScanAllowance } from '../lib/billing/trial-budget.ts'
import { ipHash, readTrialStatus, trialStatus, TRIAL_SCANS_PER_ACCOUNT, TRIAL_SCANS_PER_IP_PER_DAY } from '../lib/scan/trial.ts'
import { admitTrialSiteRead, TRIAL_SITE_READS_PER_ACCOUNT } from '../lib/scan/trial-site-read.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = Math.floor(Date.now() / 1000)
const ENV: Record<string, string> = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-fixture-operator', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  DAZL_TRIAL_SITE_READS_PER_DAY: '50', DAZL_TRIAL_SITE_READ_ALLOWLIST: 'public' }
// invented accounts; a wildcard entry and an entry with no @ are in the list on purpose: both are ignored
const LIST = ' Quest@Acme.example , qa.attempts@gmail.com,qa.total@gmail.com,qa.pw@gmail.com,qa.unconfirmed@gmail.com,*@wild.example,wild.example,'
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

bothEngines('#1579 the list: exact addresses only; unset, empty, a wildcard and an entry with no @ name nobody', async () => {
  assert.equal(trialQaExempt('quest@acme.example', {}), false, 'unset')
  assert.equal(trialQaExempt('quest@acme.example', { DAZL_TRIAL_QA_EXEMPT: ' , ' }), false, 'empty')
  assert.equal(trialQaExempt(' QUEST@acme.example ', QA), true, 'case and spaces do not matter')
  assert.equal(trialQaExempt('someone@acme.example', QA), false, 'another address on the same domain')
  assert.equal(trialQaExempt('anyone@wild.example', QA), false, 'a wildcard entry is ignored')
  assert.equal(trialQaExempt('wild.example', QA), false, 'an entry (or an address) with no @ is ignored')
  assert.equal(trialQaExempt('*@wild.example', QA), false, 'the wildcard entry does not even name itself')
  // compared as mailboxes, the way the trial already tells one mailbox from another (canonicalMailbox)
  assert.equal(trialQaExempt('quest+check@acme.example', QA), true, 'a +tag alias is the same mailbox')
  assert.equal(trialQaExempt('qaattempts@googlemail.com', QA), true, 'on Gmail, dots and googlemail.com are the same mailbox')
  assert.equal(trialQaExempt('qu.est@acme.example', QA), false, 'dots only fold on Gmail')
})

bothEngines('#1579 used attempts: the listed account is admitted for a search and a website read; an unlisted one is refused as before', async ({ db }) => {
  const env = { ...QA, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }, off = { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }
  const qa = await user(db, 'qa.attempts@gmail.com', { google: true }), other = await user(db, 'other.attempts@gmail.com', { google: true })
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
  const qa = await user(db, 'qa.total@gmail.com', { google: true }), other = await user(db, 'other.total@gmail.com', { google: true })
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
  const qa = await user(db, 'qa.pw@gmail.com'), other = await user(db, 'plain.pw@gmail.com')
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
  const unconfirmed = await user(db, 'qa.unconfirmed@gmail.com', { verified: false })
  assert.deepEqual(await scan(db, unconfirmed, QA), { ok: false, reason: 'google_required' })
  assert.deepEqual(await read(db, unconfirmed, QA), { ok: false, reason: 'google_required' })
})

bothEngines('#1579 the money guard: the global daily ceiling and a missing configuration refuse the listed account like anyone', async ({ db }) => {
  const tight = { ...QA, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.62' }
  const a = await user(db, 'a.day@gmail.com', { google: true }), qa = await user(db, 'qa.pw@gmail.com')
  await run(db, a, await scan(db, a, tight))
  await run(db, qa, await scan(db, qa, tight))
  // 0.60 of the day's 0.62 is reserved: nothing more fits, for the listed account either
  assert.deepEqual(await scan(db, qa, tight), { ok: false, reason: 'global_daily_cap' })
  assert.deepEqual(await read(db, qa, tight), { ok: false, reason: 'global_daily_cap' })
  assert.equal(await trialRefusal(db, qa, { env: tight, now: NOW }), 'global_daily_cap')
  assert.equal(await reservations(db, qa), 1, 'a refused admission reserved nothing')
  const total = Number((await db.get<{ s: number }>('SELECT sum(reserve_usd) AS s FROM trial_reservations WHERE day = (SELECT max(day) FROM trial_reservations)'))!.s)
  assert.ok(total <= 0.62 + 1e-9, `the day's reservations (${total}) stay inside the ceiling`)
  const unset: Record<string, string> = { ...QA }
  delete unset.DAZL_TRIAL_GLOBAL_DAILY_USD
  assert.deepEqual(await scan(db, qa, unset), { ok: false, reason: 'not_configured' })
  assert.deepEqual(await read(db, qa, unset), { ok: false, reason: 'not_configured' })
})

bothEngines('#1579 the first check and the counter: a listed account past its attempts is still funded and shows searches left; the network throttle stays', async ({ db, raw }) => {
  const env = { ...QA, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100', DAZL_TRIAL_GLOBAL_DAILY_USD: '100' }, off = { ...env, DAZL_TRIAL_QA_EXEMPT: '' }
  const qa = await user(db, 'qa.attempts@gmail.com', { google: true }), other = await user(db, 'other.attempts@gmail.com', { google: true })
  for (const [u, ip] of [[qa, '203.0.113.1'], [other, '203.0.113.2']] as const) for (let i = 0; i < TRIAL_SCANS_PER_ACCOUNT + 1; i++) await run(db, u, await scan(db, u, { ...env, DAZL_TRIAL_QA_EXEMPT: `${LIST},other.attempts@gmail.com` }), ip)
  const at = new Date(NOW * 1000)
  const mine = await readTrialStatus(db, qa.id, '198.51.100.7', at, penv(env))
  assert.equal(mine.funded, true)
  assert.equal(mine.remaining, TRIAL_SCANS_PER_ACCOUNT, 'the searches-left counter is not zero')
  for (const s of [await readTrialStatus(db, other.id, '198.51.100.7', at, penv(env)), await readTrialStatus(db, qa.id, '198.51.100.7', at, penv(off))])
    assert.deepEqual([s.funded, s.reason, s.remaining], [false, 'account_cap', 0], 'unlisted, or the switch empty: as before')
  if (raw) {
    // POST /api/scan's own first check reads the same store synchronously
    assert.deepEqual([trialStatus(raw, qa.id, '198.51.100.7', at, penv(env)).funded, trialStatus(raw, qa.id, '198.51.100.7', at, penv(env)).remaining], [true, TRIAL_SCANS_PER_ACCOUNT])
    assert.equal(trialStatus(raw, other.id, '198.51.100.7', at, penv(env)).reason, 'account_cap')
    assert.equal(trialStatus(raw, qa.id, '198.51.100.7', at, penv(off)).reason, 'account_cap')
  }
  // the per-network daily throttle is not a per-account limit: it still refuses the listed account
  for (let i = 0; i < TRIAL_SCANS_PER_IP_PER_DAY; i++) await db.run('INSERT INTO trial_scans (tenant_id, job_id, ip_hash, created_at) VALUES (?, ?, ?, ?)', [other.id, `none${i}`, ipHash('198.51.100.9'), NOW])
  assert.equal((await readTrialStatus(db, qa.id, '198.51.100.9', at, penv(env))).reason, 'ip_throttle')
})

bothEngines('#1579 website reads end to end: the listed account is not held to three reads; an unlisted one is; the daily ceilings stay', async ({ db }) => {
  const counts = new Map<string, number>()
  const limit = async (key: string, max: number) => { const c = (counts.get(key) ?? 0) + 1; counts.set(key, c); return { ok: c <= max, retryAfterS: 60 } }
  const env = { ...QA, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }
  const qa = await user(db, 'qa.attempts@gmail.com', { google: true }), other = await user(db, 'other.reads@gmail.com', { google: true })
  for (let i = 0; i < TRIAL_SCANS_PER_ACCOUNT; i++) await run(db, qa, await scan(db, qa, env))
  for (let i = 0; i < TRIAL_SITE_READS_PER_ACCOUNT; i++) {
    assert.equal((await admitTrialSiteRead(db, qa, '203.0.113.21', { env, limit })).ok, true)
    assert.equal((await admitTrialSiteRead(db, other, '203.0.113.22', { env, limit })).ok, true)
  }
  assert.deepEqual(await admitTrialSiteRead(db, other, '203.0.113.22', { env, limit }), { ok: false, reason: 'site_reads_used' })
  assert.equal((await admitTrialSiteRead(db, qa, '203.0.113.23', { env, limit })).ok, true, 'a fourth read, with its scan attempts used as well')
  assert.equal(await reservations(db, qa), TRIAL_SCANS_PER_ACCOUNT + TRIAL_SITE_READS_PER_ACCOUNT + 1, 'every read reserved in the ledger')
  // unset: the same account is refused by the scan count first, as before
  assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.24', { env: { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '100' }, limit }), { ok: false, reason: 'account_cap' })
  // the deployment's reads per day and the wallet's daily ceiling still stop it
  assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.25', { env: { ...env, DAZL_TRIAL_SITE_READS_PER_DAY: '1' }, limit }), { ok: false, reason: 'site_reads_busy' })
  assert.deepEqual(await admitTrialSiteRead(db, qa, '203.0.113.26', { env: { ...env, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.50' }, limit }), { ok: false, reason: 'global_daily_cap' })
})
