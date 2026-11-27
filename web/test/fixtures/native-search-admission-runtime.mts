// Own fixture for the native first-play route contract. Keep the shared estimate harness unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from '../helpers/tenant-route-db.ts'
import { setSellerLine } from '../helpers/scan-route-auth-stub.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { POST as SCAN } from '../../app/api/scan/route.ts'
import { POST as ESTIMATE } from '../../app/api/scan/estimate/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = async (url: unknown) => { throw new Error(`network fenced: ${String(url)}`) }
let n = 0
function setup() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setScanDb(db)
  return db
}
function as(db: Database.Database) {
  const id = `E${++n}`
  saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  setSellerLine(id, 'Independent compliance consulting'); setUser({ id, business_name: 'Acme' })
}
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.1.0.${++n}` }, body: JSON.stringify(body) })
const est = (body: unknown) => ESTIMATE(req('/api/scan/estimate', body))
const scan = (body: unknown) => SCAN(req('/api/scan', body))
const jobs = (db: Database.Database) => db.prepare('SELECT id FROM scan_jobs').all()
const Q = 'Independent dental practices hiring a receptionist in New York in the past 90 days'

const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' }
async function keyless(fn: (db: Database.Database, id: string) => Promise<void>) {
  const old = Object.fromEntries(Object.keys(TRIAL_ENV).map(k => [k, process.env[k]])); Object.assign(process.env, TRIAL_ENV)
  try {
    const db = setup()
    const id = `K${++n}`
    db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')").run(id, `${id}@gmail.com`)
    db.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)").run(`sub-${id}`, id)
    db.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'Acme', 'personal', ?, 1)").run(id, id) // as sign-in creates it
    setSellerLine(id, 'Independent compliance consulting'); setUser({ id, business_name: 'Acme', email: `${id}@gmail.com` })     // no API key: the shared trial funds this account
    await fn(db, id)
  } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('First-play native search admits only workspace Anthropic keys; no trial or OpenAI fallback', async () => {
  const body = { query: Q, mode: 'first5', budget: { web_search: 'anthropic_estimated_v1' } }
  await keyless(async (db, id) => {
    for (const invoke of [est, scan]) {
      const refused = await invoke(body)
      assert.equal(refused.status, 409)
      assert.equal((await refused.json()).error, 'qa_search_requires_own_key')
    }
    assert.equal(jobs(db).length, 0)
    assert.equal((db.prepare('SELECT count(*) AS c FROM trial_reservations').get() as { c: number }).c, 0)
    saveKey(db, id, 'openai', 'sk-fixture-openai-long-enough')
    for (const invoke of [est, scan]) assert.equal((await invoke(body)).status, 409)
    assert.equal(jobs(db).length, 0)
  })
})

test('First-play acknowledgement and stored budget carry the exact native marker on pinned jobs', async () => {
  const db = setup(); as(db)
  const body = { query: Q, mode: 'first5', budget: { web_search: 'anthropic_estimated_v1' }, web_search_policy: 'ignored' }
  const preview = await est(body)
  assert.equal(preview.status, 200)
  const { estimate } = await preview.json()
  assert.equal(estimate.rows.some((r: { id: string }) => r.id === 'anthropic_native_web_search'), true)
  assert.match(estimate.verdict.warning, /not a hard billing limit/)
  const response = await scan({ ...body, estimate_ack: estimate.ack })
  assert.equal(response.status, 202)
  const ack = await response.json()
  assert.equal(ack.provider_policy, 'claude_only_v1')
  assert.equal(ack.execution, 'local_once_v1')
  assert.equal(ack.web_search_policy, 'anthropic_estimated_v1')
  const job = db.prepare('SELECT run_budget, funded_by FROM scan_jobs WHERE id=?').get(ack.job_id) as { run_budget: string; funded_by: string | null }
  assert.equal(JSON.parse(job.run_budget).web_search_policy, ack.web_search_policy)
  assert.notEqual(job.funded_by, 'trial')
})


test('native search rejects the obsolete QA mode and malformed option without falling back to a scan', async () => {
  const db = setup(); as(db)
  for (const invoke of [est, scan]) {
    for (const body of [
      { query: Q, mode: 'first5_claude_only_search_v3' },
      { query: Q, mode: 'first5', budget: {} },
      { query: Q, mode: 'first5', budget: { web_search: false } },
      { query: Q, mode: 'first5', budget: { web_search: 'anthropic_estimated_v1', max_usd: 5 } },
      { query: Q, budget: { web_search: 'anthropic_estimated_v1' } },
    ]) assert.equal((await invoke(body)).status, 400)
  }
  assert.equal(jobs(db).length, 0)
})
