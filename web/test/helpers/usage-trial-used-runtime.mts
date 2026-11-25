// #1704 follow-up: GET /api/usage's trial block carries the account's real count (used, from the trial store) and the QA
// exemption, and the shared counter text (lib/trial-copy.ts) says what was really used. Before, a Google account that had
// run a free search, or the QA account whose remaining never moves, still read as a full allowance. Real route handler on a
// real SQLite store; synthetic accounts; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { GET } from '../../app/api/usage/route.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { TRIAL_SCANS_PER_ACCOUNT } from '../../lib/scan/trial.ts'
import { trialSummary, type TrialBlock } from '../../lib/trial-copy.ts'
import { readyItems } from '../../lib/ready-card.ts'

Object.assign(process.env, { DAZL_TRIAL_ANTHROPIC_KEY: 'operator-key-placeholder', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', DAZL_TRIAL_QA_EXEMPT: 'qa@gmail.com' })
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch

const uid = (n: number) => n.toString(16).padStart(32, '0')
let ip = 10
const usage = async () => {
  const r = await GET(new NextRequest('http://localhost/api/usage', { headers: { 'x-forwarded-for': `198.51.100.${ip++}` } }))
  assert.equal(r.status, 200)
  return await r.json() as { has_key: boolean; trial: TrialBlock | null }
}

test('#1704 the free-search counter reads the account\'s real used count from the trial store', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw)
  const account = async (id: string, email: string, scans: number) => {
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
    await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [id, id])
    for (let i = 0; i < scans; i++) {
      await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, ?, 'done', 'b', 'i', 'l')", [`job-${id}-${i}`, id])
      await db.run("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'h')", [id, `job-${id}-${i}`])
    }
  }
  const FRESH = uid(1), ONE = uid(2), QA = uid(3)
  await account(FRESH, 'fresh@gmail.com', 0); await account(ONE, 'one@gmail.com', 1); await account(QA, 'qa@gmail.com', 2)

  // A Google account that has not searched yet: the whole allowance, nothing used.
  setUser({ id: FRESH, business_name: 'Fresh', email: 'fresh@gmail.com' })
  const fresh = (await usage()).trial!
  assert.equal(fresh.used, 0)
  assert.equal(fresh.remaining, TRIAL_SCANS_PER_ACCOUNT)
  assert.equal(fresh.exempt, false)
  assert.equal(trialSummary(fresh).text, `${TRIAL_SCANS_PER_ACCOUNT} free searches left.`)

  // After one free search on a Google account the route says it was used, and every page's counter says so.
  setUser({ id: ONE, business_name: 'One', email: 'one@gmail.com' })
  const one = (await usage()).trial!
  assert.equal(one.used, 1, 'the route carries the used count from the trial store')
  assert.equal(one.remaining, TRIAL_SCANS_PER_ACCOUNT - 1)
  assert.equal(one.exempt, false)
  const left = `${TRIAL_SCANS_PER_ACCOUNT - 1} free searches left (1 used)`
  assert.equal(trialSummary(one).text, `${left}.`)
  const search = readyItems({ profile: null, usage: { has_key: false, trial: one }, keys: [], rejection: null, outreach: null,
    sources: { web_index: false, news: true, websites: true }, advanced: null, jobs: [], totals: { searches: 1, finished: 1 }, campaigns: [], messages: [] }).find(x => x.id === 'search')!
  assert.ok(search.detail.startsWith(`${left}. `), `Home says the same count: ${search.detail}`)

  // The QA account's remaining never moves (no per-account count), so the counter says it is the QA account and what it used,
  // never a full "3 left" after it has searched.
  setUser({ id: QA, business_name: 'QA', email: 'qa@gmail.com' })
  const qa = (await usage()).trial!
  assert.equal(qa.exempt, true)
  assert.equal(qa.used, 2)
  assert.equal(trialSummary(qa).text, 'QA account: unlimited free searches (2 used).')
  const qaSearch = readyItems({ profile: null, usage: { has_key: false, trial: qa }, keys: [], rejection: null, outreach: null,
    sources: { web_index: false, news: true, websites: true }, advanced: null, jobs: [], totals: { searches: 2, finished: 2 }, campaigns: [], messages: [] }).find(x => x.id === 'search')!
  assert.ok(qaSearch.detail.startsWith('QA account: unlimited free searches (2 used). '), `Home: ${qaSearch.detail}`)
  console.log('USAGE_TRIAL_USED ok')
})
