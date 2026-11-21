// #1095 through the real routes (loaded by test/first-search-1095.test.ts with auth-after-loader.mjs): a brand-new
// password sign-up (POST /api/auth/signup, the real session cookie) reads GET /api/usage the way the first-run ready step
// does, and that real answer decides what the ready step offers (lib/trial-copy.ts firstSearchOffer). The free trial is
// configured and funded; only the Google rule refuses it. The offer must be the way forward (Link Google back to the
// same search), in words, never a key-only dead end and never a raw code; POST /api/scan with the ready step's body is
// refused in the same words. SQLite store; no mail, network, model or spend.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { withJar } from './pg-session-headers.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
// The free trial is fully set up (operator key, ceilings, prices): nothing but the account's own Google rule refuses it.
Object.assign(process.env, {
  DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-api03-FIRSTSEARCHFIRSTSEARCHFIRSTSEARCH', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.50',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002',
  SYSTEM_MAIL_SMTP_URL: 'smtp://fixture.invalid', SYSTEM_MAIL_FROM: 'fixture@example.test',
})
const { setTransportForTests } = await import('../../lib/system-mail.ts')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
// The confirmation mail stays in the process: kept here so the test opens its link as the new owner would.
const sent: { to: string; text: string }[] = []
setTransportForTests(async m => { sent.push({ to: m.to, text: m.text }) })

const signup = await import('../../app/api/auth/signup/route.ts')
const verify = await import('../../app/api/auth/verify/route.ts')
const signin = await import('../../app/api/auth/signin/route.ts')
const usage = await import('../../app/api/usage/route.ts')
const scan = await import('../../app/api/scan/route.ts')
const { firstSearchOffer, trialRefusalNotice } = await import('../../lib/trial-copy.ts')

const RAW = /\b(trial_unavailable|google_required|domain_used|attempts_cap|account_total_cap|global_daily_cap|not_configured|account_cap|ip_throttle|no_api_key)\b/
const req = (path: string, method: string, body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': '203.0.113.7' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

// The prod live check's account and search (the prod live check, 2026-11-13): a confirmed password account
// (signed up through the form, confirmed through the emailed link), no key, no Google, and its search
// "Dental clinics in Austin hiring a front desk manager".
const PROD_QUERY = 'Dental clinics in Austin hiring a front desk manager'

test('#1095 a new password sign-up: the real /api/usage answer makes the ready step offer Link Google to the same search, in words', async () => {
  const EMAIL = 'newowner@clinicgroup.example', PASSWORD = 'a strong password 1095'
  const su = await withJar(new Map(), () => signup.POST(req('/api/auth/signup', 'POST', { email: EMAIL, password: PASSWORD, name: 'N', business_name: 'Clinic Group' })))
  assert.equal(su.status, 200, await su.clone().text())
  const token = sent.filter(m => m.to === EMAIL).map(m => /\/verify#t=([a-f0-9]{64})/.exec(m.text)?.[1]).find(Boolean)
  assert.ok(token, 'a confirmation link went to the new address')
  assert.equal((await verify.POST(req('/api/auth/verify', 'POST', { token }))).status, 200)
  const jar = new Map<string, string>()
  const si = await withJar(jar, () => signin.POST(req('/api/auth/signin', 'POST', { email: EMAIL, password: PASSWORD })))
  assert.equal(si.status, 200, await si.clone().text())
  assert.ok(jar.get('dazl_session'), 'signed in as the new account')

  const u = await withJar(jar, () => usage.GET(req('/api/usage', 'GET')))
  assert.equal(u.status, 200)
  const body = await u.json() as { has_key: boolean; trial: { funded: boolean; remaining: number; cap: number; blocked: string | null } | null }
  // The real shape the first-run page reads (the same as prod's: has_key false, trial blocked google_required, 3 left).
  assert.equal(body.has_key, false)
  assert.deepEqual(body.trial, { funded: false, remaining: 3, cap: 3, blocked: 'google_required' })

  const offer = firstSearchOffer(body)
  assert.deepEqual(offer, { kind: 'refused', reason: 'google_required', heading: 'Link Google to start free' })
  assert.doesNotMatch(offer.heading, RAW)
  // The notice the ready step shows up front for that offer: words and Link Google back to this page.
  const n = trialRefusalNotice(offer.reason, '/app', { verified: false, google: false, fresh: true })
  assert.equal(n.text, 'Free scans need a Google account. Link Google to run this search free (no card).')
  assert.ok(n.actions.some(a => a.kind === 'link_google' && a.href === '/api/auth/google?link=1&next=%2Fapp'), JSON.stringify(n.actions))
  for (const a of n.actions) assert.doesNotMatch(a.label, RAW)

  // Running the search anyway (the ready step's body: the sentence, the profile, mode first5) is refused before any job,
  // with the same reason the offer was built from: nothing starts, nothing is reserved.
  const icp = { summary: 'Independent dental clinics', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Austin, TX'], signals: ['hiring a front desk manager'], exclude: [] }
  const s = await withJar(jar, () => scan.POST(req('/api/scan', 'POST', { query: PROD_QUERY, icp, mode: 'first5' })))
  assert.equal(s.status, 402)
  assert.deepEqual(await s.json(), { error: 'trial_unavailable', reason: 'google_required' })
  assert.equal((raw.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, 0)
  assert.equal((raw.prepare('SELECT count(*) AS n FROM trial_reservations').get() as { n: number }).n, 0)
  console.log('FIRST SEARCH 1095 ROUTES ok')
})
