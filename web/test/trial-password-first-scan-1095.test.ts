// #1095: an account created with a password (email confirmed, no Google) gets ONE free first search. Before this it was
// refused google_required at its first search, so every password sign-up stopped there. What still holds, pinned below:
// an unconfirmed address, a second free scan, a website read, a +tag or dotted alias of a mailbox that already drew on
// the trial, a second account on a company domain, and every money ceiling. Linking Google gives the usual three.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, admitTrialSiteReadBudget, canonicalMailbox, linkTrialReservation, PASSWORD_TRIAL_SCANS, trialRefusal, trialScanAllowance } from '../lib/billing/trial-budget.ts'
import { readTrialStatus, TRIAL_SCANS_PER_ACCOUNT } from '../lib/scan/trial.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = 1_800_000_000
const ENV = { DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10' }
let n = 0
const user = async (db: Db, email: string, o: { verified?: boolean; google?: boolean } = {}) => {
  const id = (++n).toString(16).padStart(32, '0')
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, email_verified_at) VALUES (?, ?, 'n', 'b', 'x', 'y', ?)", [id, email, o.verified === false ? null : NOW - 60])
  if (o.google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
const admit = (db: Db, u: { id: string; email: string }, env: Record<string, string> = ENV) => admitTrialScan(db, u, { env, now: NOW })
// the scan the admission paid for, still running: it holds its attempt
const run = async (db: Db, u: { id: string }, a: Awaited<ReturnType<typeof admitTrialScan>>) => {
  assert.ok(a.ok, JSON.stringify(a))
  const id = `job${String(++n).padStart(21, '0')}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, ?, 'b', 'i', 'l', 'running', ?)", [id, u.id, NOW])
  await linkTrialReservation(db, u.id, a.reservation, id)
}

bothEngines('#1095 a confirmed password account runs its first search free, then is asked to link Google; Google then gives the rest', async ({ db }) => {
  const pw = await user(db, 'pat@gmail.com')
  assert.equal(await trialRefusal(db, pw, { env: ENV, now: NOW }), null, 'the first search would run')
  await run(db, pw, await admit(db, pw))
  assert.deepEqual(await admit(db, pw), { ok: false, reason: 'google_required' }, 'one free search without Google, not three')
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'sub-pat', ?)", [pw.id])
  for (let i = PASSWORD_TRIAL_SCANS; i < TRIAL_SCANS_PER_ACCOUNT; i++) await run(db, pw, await admit(db, pw))
  assert.deepEqual(await admit(db, pw), { ok: false, reason: 'attempts_cap' }, 'the first search counts toward the three')
})

bothEngines('#1095 what the password path still refuses: unconfirmed address, website read, the switch off, an alias of a used mailbox, a used company domain', async ({ db }) => {
  const unconfirmed = await user(db, 'una@gmail.com', { verified: false })
  assert.deepEqual(await admit(db, unconfirmed), { ok: false, reason: 'google_required' })
  const pw = await user(db, 'Pat.Smith@gmail.com')
  // owner, 2026-11-24 (free website reads for every new account): the read that comes before the first search in onboarding is
  // admitted for a confirmed password account; for an unconfirmed one, and with the switch off, it still needs Google
  assert.equal((await admitTrialSiteReadBudget(db, pw, { env: ENV, now: NOW })).ok, true, 'a confirmed password account has its website read')
  assert.deepEqual(await admitTrialSiteReadBudget(db, unconfirmed, { env: ENV, now: NOW }), { ok: false, reason: 'google_required' }, 'an unconfirmed address still needs Google for a read')
  assert.deepEqual(await admitTrialSiteReadBudget(db, pw, { env: { ...ENV, DAZL_TRIAL_PASSWORD_FIRST_SCAN: '0' }, now: NOW }), { ok: false, reason: 'google_required' }, 'off switch: reads need Google too')
  assert.deepEqual(await admit(db, pw, { ...ENV, DAZL_TRIAL_PASSWORD_FIRST_SCAN: '0' }), { ok: false, reason: 'google_required' }, 'off switch')
  await run(db, pw, await admit(db, pw))
  for (const alias of ['patsmith+two@gmail.com', 'p.a.t.smith@googlemail.com'])
    assert.deepEqual(await admit(db, await user(db, alias)), { ok: false, reason: 'google_required' }, `${alias} is the same mailbox`)
  assert.equal((await admit(db, await user(db, 'someone.else@gmail.com'))).ok, true, 'a different mailbox is its own account')
  const first = await user(db, 'ann@acme.example')
  await run(db, first, await admit(db, first))
  assert.deepEqual(await admit(db, await user(db, 'bob@acme.example')), { ok: false, reason: 'domain_used' }, 'one trial per company domain')
  assert.equal(canonicalMailbox('P.a.t+x@GoogleMail.com'), 'pat@gmail.com')
  assert.equal(canonicalMailbox('a.b+c@outlook.com'), 'a.b@outlook.com', 'dots only fold on Gmail')
})

bothEngines('#1095 the money ceilings bind a password account as they bind any other; the counter shows one free search, not three', async ({ db }) => {
  const pw = await user(db, 'pat@gmail.com'), g = await user(db, 'gil@gmail.com', { google: true })
  assert.deepEqual(await admit(db, pw, { ...ENV, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.20' }), { ok: false, reason: 'global_daily_cap' })
  assert.deepEqual(await admit(db, pw, { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.20' }), { ok: false, reason: 'account_total_cap' })
  assert.equal(await trialScanAllowance(db, pw.id, ENV), PASSWORD_TRIAL_SCANS)
  assert.equal(await trialScanAllowance(db, g.id, ENV), TRIAL_SCANS_PER_ACCOUNT)
  const env = { ...ENV, DAZL_TRIAL_ANTHROPIC_KEY: 'sk-fixture' } as unknown as NodeJS.ProcessEnv
  assert.equal((await readTrialStatus(db, pw.id, '203.0.113.5', new Date(NOW * 1000), env)).remaining, 1)
  assert.equal((await readTrialStatus(db, g.id, '203.0.113.5', new Date(NOW * 1000), env)).remaining, 3)
})
