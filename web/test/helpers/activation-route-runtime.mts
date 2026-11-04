// #409 time-to-value and drop-off, through the real POST /api/scan/icp-from-url and POST /api/settings/profile handlers on
// a real SQLite store: every website read that reaches the page leaves one `onboarding.site_read` audit event with its
// path, result and reason (configured trial, missing operator key, exhausted budget, JS-only page, fetch failure, a read
// that throws), a failed audit write never changes the answer, and the journey reads back stage by stage
// (lib/scan/activation.ts). Synthetic accounts; the page fetch and model call are stubbed (icp-from-site-stub.ts); no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { next } from './icp-from-site-stub.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { readActivation, SITE_READ_ACTION } from '../../lib/scan/activation.ts'
import { POST } from '../../app/api/scan/icp-from-url/route.ts'
import { POST as profilePost } from '../../app/api/settings/profile/route.ts'

const OP = 'sk-ant...ATOR'
Object.assign(process.env, { DAZL_TRIAL_ANTHROPIC_KEY: OP, DAZL_TRIAL_SITE_READS_PER_DAY: '50', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_SITE_READ_ALLOWLIST: 'ok@gmail.com,nokey@gmail.com,poor@gmail.com,page@gmail.com,boom@gmail.com,audit@gmail.com,other@gmail.com', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' })
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch

const uid = (n: number) => n.toString(16).padStart(32, '0')
let ip = 10
const headers = () => ({ 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `198.51.100.${ip++}` })
const read = async () => {
  const r = await POST(new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: headers(), body: JSON.stringify({ url: 'https://acme.example' }) }))
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}
const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { await fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('#409 every website read is recorded with its path, result and reason; the journey reads back stage by stage', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw)
  const founder = async (n: number, email: string, createdAt = 1_700_000_000) => {
    const id = uid(n)
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
    await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, ?)", [id, id, createdAt])
    setUser({ id, business_name: 'b', email })
    return id
  }
  const events = async (id: string) => (await db.all<{ decision: string; summary: string; resource_type: string }>('SELECT decision, summary, resource_type FROM audit_events WHERE tenant_id = ? AND action = ? ORDER BY at, seq', [id, SITE_READ_ACTION]))
    .map(e => ({ decision: e.decision, resource: e.resource_type, ...JSON.parse(e.summary) }))

  // 1. Configured trial, eligible founder: a drafted profile on the trial.
  const OK = await founder(1, 'ok@gmail.com')
  let r = await read()
  assert.equal(r.status, 200); assert.equal(r.body.funded, 'trial', JSON.stringify(r.body))
  assert.deepEqual(await events(OK), [{ decision: 'allowed', resource: 'website', path: 'trial', result: 'profile', reason: null }])

  // 2. Missing operator key: the free read with not_configured (the deployment's honest "not available here").
  const NOKEY = await founder(2, 'nokey@gmail.com')
  await withEnv({ DAZL_TRIAL_ANTHROPIC_KEY: undefined }, async () => { r = await read() })
  assert.equal(r.status, 200); assert.equal(r.body.trial, 'not_configured')
  assert.deepEqual(await events(NOKEY), [{ decision: 'allowed', resource: 'website', path: 'free', result: 'facts', reason: 'not_configured' }])

  // 3. Exhausted budget: the free read with the money ceiling.
  const POOR = await founder(3, 'poor@gmail.com')
  await withEnv({ DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.01' }, async () => { r = await read() })
  assert.equal(r.body.trial, 'account_total_cap')
  assert.deepEqual(await events(POOR), [{ decision: 'allowed', resource: 'website', path: 'free', result: 'facts', reason: 'account_total_cap' }])

  // 4. JS-only page and fetch failures (blocked, timeout): the route's error answer, recorded as denied with the code.
  const PAGE = await founder(4, 'page@gmail.com')
  for (const error of ['js_only', 'blocked', 'timeout']) { next.error = error; r = await read(); assert.equal(r.body.error, error) }
  assert.deepEqual((await events(PAGE)).map(e => [e.decision, e.path, e.result, e.reason]), [['denied', 'free', 'error', 'js_only'], ['denied', 'free', 'error', 'blocked'], ['denied', 'free', 'error', 'timeout']])

  // 5. A read that throws: recorded as an error first, then the exception still surfaces (never swallowed).
  const BOOM = await founder(5, 'boom@gmail.com')
  next.throws = true
  await assert.rejects(read(), /read exploded/)
  assert.deepEqual(await events(BOOM), [{ decision: 'denied', resource: 'website', path: 'free', result: 'error', reason: 'exception' }])

  // 6. The audit write fails: the user's answer is unchanged (the failure is reported, lib/audit-route.ts).
  await founder(6, 'audit@gmail.com')
  raw.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit store down'); END")
  r = await read()
  assert.equal(r.status, 200); assert.equal(r.body.funded, 'trial', 'a failed record never changes the answer')
  raw.exec('DROP TRIGGER audit_fail')

  // 6b. A bad address stops before the fetch: recorded with path 'none'. Past the route's 5-per-hour limit a press is
  //     refused 429 and NOT recorded, so a looping client cannot turn refusals into unbounded audit writes.
  const BAD = await founder(8, 'bad@gmail.com')
  for (let i = 0; i < 5; i++) {
    const b = await POST(new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: headers(), body: JSON.stringify({ url: i % 2 ? 'x' : { not: 'a string' } }) }))
    assert.equal(b.status, 400)
  }
  const limited = await POST(new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: headers(), body: JSON.stringify({ url: 'x' }) }))
  assert.equal(limited.status, 429)
  assert.deepEqual((await events(BAD)).map(e => [e.decision, e.path, e.result, e.reason]), Array(5).fill(['denied', 'none', 'error', 'invalid']))

  // 7. The whole journey for the trial founder: profile saved through the real route, a scan, then a verified lead.
  setUser({ id: OK, business_name: 'b', email: 'ok@gmail.com' })
  let j = await readActivation(db, db, OK)
  assert.ok(!('unknown' in j)); assert.equal(j.dropped_at, 'saved_offer'); assert.equal(j.ttv_s, null)
  const saved = await profilePost(new NextRequest('http://localhost/api/settings/profile', { method: 'POST', headers: headers(), body: JSON.stringify({ sells: 'CRM cleanup for sales teams', website: 'https://acme.example', business_name: 'Acme' }) }))
  assert.equal(saved.status, 200, await saved.clone().text())
  j = await readActivation(db, db, OK)
  assert.ok(!('unknown' in j)); assert.equal(j.dropped_at, 'started_scan')
  await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at) VALUES ('job-ok', ?, 'running', 'b', 'i', 'l', 1700000600)", [OK])
  await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, created_at) VALUES ('lead-ok', 'job-ok', 'Orbitly', 'raised a seed round', 'https://press.example/a', 80, 1700003600)")
  j = await readActivation(db, db, OK)
  assert.ok(!('unknown' in j))
  assert.equal(j.dropped_at, null); assert.equal(j.ttv_s, 3600, 'sign-up at 1700000000, first verified lead at 1700003600')
  assert.deepEqual(j.first_read, { path: 'trial', result: 'profile', reason: null })
  // Another workspace's rows never count for this one (tenant isolation of every stage).
  const OTHER = await founder(7, 'other@gmail.com')
  const o = await readActivation(db, db, OTHER)
  assert.ok(!('unknown' in o)); assert.equal(o.dropped_at, 'read_site'); assert.equal(o.reads, 0); assert.equal(o.at.verified_lead, null)
  console.log('ACTIVATION_ROUTE ok')
})
