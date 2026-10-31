// POST /api/scan/icp-from-url's trial admission, through the real route handler on a real SQLite store: the trial is the
// workspace's own (its founder's account, read on the server), never the acting member's. Instinct's negative on
// fa220d8: an owner refused for an already-used company domain must stay refused when an invited member with a free
// email address acts in that workspace. Synthetic accounts; the page fetch and model call are stubbed
// (icp-from-site-stub.ts); no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { handedKeys, next } from './icp-from-site-stub.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { admitTrialScan } from '../../lib/billing/trial-budget.ts'
import { POST } from '../../app/api/scan/icp-from-url/route.ts'

const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
Object.assign(process.env, { DAZL_TRIAL_ANTHROPIC_KEY: OP, DAZL_TRIAL_SITE_READS_PER_DAY: '50', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' })
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch

const uid = (n: number) => n.toString(16).padStart(32, '0')
let ip = 10
const post = async () => {
  const req = new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `198.51.100.${ip++}` }, body: JSON.stringify({ url: 'https://acme.example' }) })
  const before = handedKeys.length
  const r = await POST(req)
  const j = await r.json() as { error?: string; trial?: string }
  return { trial: j.trial ?? null, operatorKey: handedKeys.length > before }
}

test('the site read trial is the workspace founder\'s own account, acting itself (owner, invited member, another actor, Google, same domain, team workspace)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw)
  const account = async (id: string, email: string, personal = true, google = true) => {
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
    if (google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
    if (personal) await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [id, id])
  }
  const PRIOR = uid(1), OWNER = uid(2), INVITED = uid(3), FREE = uid(4), CORP_ACTOR = uid(5), TEAM = uid(6), NOGOOGLE = uid(7), SAME = uid(8)
  await account(PRIOR, 'b@corp.example'); await account(OWNER, 'a@corp.example'); await account(INVITED, 'invited@gmail.com')
  await account(FREE, 'solo@gmail.com'); await account(CORP_ACTOR, 'c@corp.example')
  assert.equal((await admitTrialScan(db, { id: PRIOR, email: 'b@corp.example' }, { env: process.env })).ok, true, 'fixture: corp.example already used a trial')

  // 1. Same-domain control: the founder of a workspace whose company domain already had its trial is refused.
  setUser({ id: OWNER, business_name: 'Acme', email: 'a@corp.example' })
  assert.deepEqual(await post(), { trial: 'domain_used', operatorKey: false }, 'owner: domain_used')
  // 2. Instinct's negative: the same workspace, acted in by an invited member with a free address. Refused, no key.
  setUser({ id: OWNER, actorId: INVITED, role: 'operator', business_name: 'Acme', email: 'invited@gmail.com' })
  assert.deepEqual(await post(), { trial: 'workspace_not_eligible', operatorKey: false }, 'invited member: never the workspace trial')
  // 3. Positive control: an eligible workspace's founder is admitted (the operator key is handed to the read).
  setUser({ id: FREE, business_name: 'Solo', email: 'solo@gmail.com' })
  assert.deepEqual(await post(), { trial: null, operatorKey: true }, 'eligible founder: admitted')
  // 4. Another member acting in that eligible workspace (own address at the used domain or not): refused, as for scans.
  for (const [actor, email] of [[CORP_ACTOR, 'c@corp.example'], [INVITED, 'invited@gmail.com']]) {
    setUser({ id: FREE, actorId: actor, role: 'operator', business_name: 'Solo', email })
    assert.deepEqual(await post(), { trial: 'workspace_not_eligible', operatorKey: false }, `member ${email} in an eligible workspace`)
  }
  // 5. The founder's own Google sign-in decides, not a member's: a founder without one is refused google_required.
  await account(NOGOOGLE, 'nog@fresh.example', true, false)
  setUser({ id: NOGOOGLE, business_name: 'NoG', email: 'nog@fresh.example' })
  assert.deepEqual(await post(), { trial: 'google_required', operatorKey: false }, 'founder without Google sign-in')
  // 6. Same-domain control for the session email: a founder whose session claims another address is judged by its own
  //    users row (corp.example, used), never by the session's. getSessionUser reads both from one users row, so the
  //    store cannot produce this session today; the case pins that admission never reads the session's email.
  await account(SAME, 'd@corp.example')
  setUser({ id: SAME, business_name: 'Corp D', email: 'd-alias@gmail.com' })
  assert.deepEqual(await post(), { trial: 'domain_used', operatorKey: false }, 'founder: the stored address decides')
  // 7. A team workspace (no founder users row for its id): fails closed, whoever acts.
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'Team', 'team', ?, 1)", [TEAM, FREE])
  for (const [actor, email] of [[FREE, 'solo@gmail.com'], [INVITED, 'invited@gmail.com'], [TEAM, 'team@gmail.com']]) {
    setUser({ id: TEAM, actorId: actor, role: 'owner', business_name: 'Team', email })
    assert.deepEqual(await post(), { trial: 'workspace_not_eligible', operatorKey: false }, `team workspace, actor ${email}`)
  }
  console.log('SITE_READ_ROUTE ok')
})

test('#444 restack: the route keeps both refusals apart: the owner pool\'s spend_limit (429, main\'s message, no trial reason), a failed trial read (502), a refused trial (400 with its reason)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw)
  const FOUNDER = uid(21)
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, 'f@gmail.com', 'n', 'b', 'x', 'y')", [FOUNDER])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [FOUNDER, FOUNDER])
  setUser({ id: FOUNDER, business_name: 'F', email: 'f@gmail.com' })
  const call = async () => {
    const req = new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `198.51.100.${ip++}` }, body: JSON.stringify({ url: 'https://acme.example' }) })
    const r = await POST(req)
    return { status: r.status, body: await r.json() as { error?: string; message?: string; trial?: string } }
  }
  // 1. The owner's workspace spend limit (an own-key read the pool refused): main's 429 and message, and no trial reason.
  next.error = 'spend_limit'
  const limit = await call()
  assert.equal(limit.status, 429)
  assert.equal(limit.body.error, 'spend_limit')
  assert.match(limit.body.message ?? '', /workspace AI spend limit/)
  assert.equal(limit.body.trial, undefined)
  // 2. A trial read that failed on dazl's side: 502 with trial_read_failed, never the owner's spend_limit, no trial reason.
  next.error = 'trial_read_failed'
  assert.deepEqual(await call(), { status: 502, body: { error: 'trial_read_failed' } })
  // 3. A refused trial (this founder has no Google sign-in): 400 with no_api_key and the reason, nothing handed to a read.
  const before = handedKeys.length
  assert.deepEqual(await call(), { status: 400, body: { error: 'no_api_key', trial: 'google_required' } })
  assert.equal(handedKeys.length, before)
  console.log('SITE_READ_ROUTE_ERRORS ok')
})

// Council R3-4 on d6c89bf2: every refusal reason the route can return, through the real admission on the real store (the
// read itself stubbed). limit_unavailable cannot be reached through the route: its own icpurl limiter fails closed first
// (429) when the shared store is down; test/trial-site-read.test.ts covers it at the admission.
test('#444 R3-4: not_configured, account_cap, account_total_cap, global_daily_cap and ip_throttle through the real admission; key_unreadable 400, js_only 422, key_rejected 502', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw)
  const founder = async (n: number, email: string) => {
    const id = uid(n)
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
    await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [id, id])
    setUser({ id, business_name: 'b', email })
    return id
  }
  const call = async (fromIp = `198.51.100.${ip++}`) => {
    const req = new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': fromIp }, body: JSON.stringify({ url: 'https://acme.example' }) })
    const r = await POST(req)
    return { status: r.status, body: await r.json() as { error?: string; trial?: string } }
  }
  const saved = { ...process.env }
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    try { await fn() } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
  }
  const reservations = async (id: string) => Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trial_reservations WHERE tenant_id = ?', [id]))!.n)
  // 1. No daily ceiling set by the operator: the read is off, whatever else is configured.
  const A = await founder(41, 'nc@gmail.com')
  await withEnv({ DAZL_TRIAL_SITE_READS_PER_DAY: undefined }, async () => assert.deepEqual(await call(), { status: 400, body: { error: 'no_api_key', trial: 'not_configured' } }))
  // 2. The trial's own per-account scan count is used up (lib/scan/trial.ts): account_cap, before any reservation.
  const B = await founder(42, 'cap@gmail.com')
  for (let i = 0; i < 3; i++) {
    await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, ?, 'done', 'b', 'i', 'l')", [`job-${i}`, B])
    await db.run("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'h')", [B, `job-${i}`])
  }
  assert.deepEqual(await call(), { status: 400, body: { error: 'no_api_key', trial: 'account_cap' } })
  assert.equal(await reservations(B), 0)
  // 3. The wallet's ceilings against the read's reserve: account total, then the global day.
  const C = await founder(43, 'poor@gmail.com')
  await withEnv({ DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.01' }, async () => assert.deepEqual(await call(), { status: 400, body: { error: 'no_api_key', trial: 'account_total_cap' } }))
  await withEnv({ DAZL_TRIAL_GLOBAL_DAILY_USD: '0.01' }, async () => assert.deepEqual(await call(), { status: 400, body: { error: 'no_api_key', trial: 'global_daily_cap' } }))
  assert.equal(await reservations(C), 0, 'a refused read reserves nothing')
  // 4. The network throttle: the seventh founder from one address today is refused, the first six admitted.
  const NET = '203.0.113.77'
  for (let i = 0; i < 6; i++) { await founder(50 + i, `net${i}@gmail.com`); const r = await call(NET); assert.equal(r.body.trial, undefined, `founder ${i} from ${NET}: admitted (${JSON.stringify(r)})`) }
  await founder(56, 'net6@gmail.com')
  assert.deepEqual(await call(NET), { status: 400, body: { error: 'no_api_key', trial: 'ip_throttle' } })
  // 5. The read's own typed failures map as before: a stored key that cannot be read, a page without text, a bad answer.
  setUser({ id: A, business_name: 'b', email: 'nc@gmail.com' })
  for (const [error, status] of [['key_unreadable', 400], ['js_only', 422], ['key_rejected', 502]] as const) {
    next.error = error
    assert.deepEqual(await call(), { status, body: { error } }, error)
  }
  console.log('SITE_READ_ROUTE_REASONS ok')
})
