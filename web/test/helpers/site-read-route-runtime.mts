// POST /api/scan/icp-from-url's trial admission, through the real route handler on a real SQLite store: the trial is the
// workspace's own (its founder's account, read on the server), never the acting member's. The free read is main's floor:
// every keyless read answers 200 with the page's own facts, the trial decision riding on it as `trial` (a refusal
// reason, 'read_failed', or absent on a funded draft) - never a 400 no_api_key, which hid the read (#409 port). Instinct's negative on
// fa220d8: an owner refused for an already-used company domain must stay refused when an invited member with a free
// email address acts in that workspace. Synthetic accounts; the page fetch and model call are stubbed
// (icp-from-site-stub.ts); no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { calls, handedKeys, next } from './icp-from-site-stub.ts'
import { GET as usageGet } from '../../app/api/usage/route.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { admitTrialScan } from '../../lib/billing/trial-budget.ts'
import { POST } from '../../app/api/scan/icp-from-url/route.ts'

const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
// Every fixture account these subtests carry past eligibility, on the allowlist the funded path requires (#409 bounded
// activation); the gate itself is pinned in test/trial-site-read.test.ts.
Object.assign(process.env, { DAZL_TRIAL_ANTHROPIC_KEY: OP, DAZL_TRIAL_SITE_READS_PER_DAY: '50', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_SITE_READ_ALLOWLIST: 'a@corp.example,solo@gmail.com,invited@gmail.com,c@corp.example,f@gmail.com,nc@gmail.com,cap@gmail.com,poor@gmail.com,net0@gmail.com,net1@gmail.com,net2@gmail.com,net3@gmail.com,net4@gmail.com,net5@gmail.com,net6@gmail.com,used@gmail.com,busy1@gmail.com,busy2@gmail.com,attempts@gmail.com,f61@gmail.com',
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

test('#444 restack + port: the route keeps both refusals apart: the owner pool\'s spend_limit (429, main\'s message, no trial reason), a failed trial read (200 free read + read_failed), a refused trial (200 free read with its reason)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw)
  const FOUNDER = uid(21), NOGOOG = uid(22)
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, 'f@gmail.com', 'n', 'b', 'x', 'y')", [FOUNDER])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'sub-f', ?)", [FOUNDER])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [FOUNDER, FOUNDER])
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, 'ng@gmail.com', 'n', 'b', 'x', 'y')", [NOGOOG])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b2', 'personal', ?, 1)", [NOGOOG, NOGOOG])
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
  // 2. A trial read that failed on dazl's side AFTER its call: the free read with 'read_failed' (that read counted),
  // never the owner's spend_limit, never an error that hides the page's own facts.
  next.outcome = 'call_failed'
  const failed = await call()
  assert.equal(failed.status, 200)
  assert.equal((failed.body as { free?: boolean }).free, true)
  assert.equal(failed.body.trial, 'read_failed')
  // 3. A refused trial (this founder has no Google sign-in): the free read with the reason, nothing handed to a read.
  setUser({ id: NOGOOG, business_name: 'NG', email: 'ng@gmail.com' })
  const before = handedKeys.length
  const refused = await call()
  assert.equal(refused.status, 200)
  assert.equal((refused.body as { free?: boolean }).free, true)
  assert.equal(refused.body.trial, 'google_required')
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
  // Every refusal below: 200, the free read, and the reason as `trial` (the port; the 400/no_api_key shape hid the read).
  const refused = async (reason: string, fromIp?: string) => {
    const r = await call(fromIp)
    assert.equal(r.status, 200, reason)
    assert.equal((r.body as { free?: boolean }).free, true, reason)
    assert.equal(r.body.trial, reason, JSON.stringify(r.body))
  }
  // 1. No daily ceiling set by the operator: the read is off, whatever else is configured.
  const A = await founder(41, 'nc@gmail.com')
  await withEnv({ DAZL_TRIAL_SITE_READS_PER_DAY: undefined }, () => refused('not_configured'))
  // 2. The trial's own per-account scan count is used up (lib/scan/trial.ts): account_cap, before any reservation.
  const B = await founder(42, 'cap@gmail.com')
  for (let i = 0; i < 3; i++) {
    await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, ?, 'done', 'b', 'i', 'l')", [`job-${i}`, B])
    await db.run("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'h')", [B, `job-${i}`])
  }
  await refused('account_cap')
  assert.equal(await reservations(B), 0)
  // 3. The wallet's ceilings against the read's reserve: account total, then the global day.
  const C = await founder(43, 'poor@gmail.com')
  await withEnv({ DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.01' }, () => refused('account_total_cap'))
  await withEnv({ DAZL_TRIAL_GLOBAL_DAILY_USD: '0.01' }, () => refused('global_daily_cap'))
  assert.equal(await reservations(C), 0, 'a refused read reserves nothing')
  // 4. The network throttle: the seventh founder from one address today is refused, the first six admitted.
  const NET = '203.0.113.77'
  for (let i = 0; i < 6; i++) { await founder(50 + i, `net${i}@gmail.com`); const r = await call(NET); assert.equal((r.body as { funded?: string }).funded, 'trial', `founder ${i} from ${NET}: admitted (${JSON.stringify(r)})`) }
  await founder(56, 'net6@gmail.com')
  await refused('ip_throttle', NET)
  // 5. The read's own typed failures map as before: a stored key that cannot be read, a page without text, a bad answer.
  setUser({ id: A, business_name: 'b', email: 'nc@gmail.com' })
  for (const [error, status] of [['key_unreadable', 400], ['js_only', 422], ['key_rejected', 502]] as const) {
    next.error = error
    assert.deepEqual(await call(), { status, body: { error } }, error)
  }
  // 6. Council round 2 R4-3: the account's own cap, the deployment ceiling, and the trial's attempt cap.
  const D = await founder(70, 'used@gmail.com')
  const readFailed = async () => { next.outcome = 'call_failed'; const r = await call(); assert.equal(r.status, 200); assert.equal(r.body.trial, 'read_failed', JSON.stringify(r.body)) }
  for (let i = 0; i < 3; i++) await readFailed()
  await refused('site_reads_used')
  const dayBefore = Number((await db.get<{ c: number }>("SELECT count AS c FROM rate_limits WHERE key = 'trial-site-day:all'"))!.c)
  await refused('site_reads_used')
  assert.equal(Number((await db.get<{ c: number }>("SELECT count AS c FROM rate_limits WHERE key = 'trial-site-day:all'"))!.c), dayBefore, 'a reads-used account burns no deployment slot (R1-3)')
  await withEnv({ DAZL_TRIAL_SITE_READS_PER_DAY: '1' }, async () => {
    await db.run("DELETE FROM rate_limits WHERE key = 'trial-site-day:all'")
    await founder(71, 'busy1@gmail.com'); await readFailed()
    await founder(72, 'busy2@gmail.com')
    await refused('site_reads_busy')
  })
  const E = await founder(73, 'attempts@gmail.com')
  for (let i = 0; i < 3; i++) assert.equal((await admitTrialScan(db, { id: E, email: 'attempts@gmail.com' })).ok, true)
  await refused('attempts_cap')
  void D
  console.log('SITE_READ_ROUTE_REASONS ok')
})

// Adversarial probe on d6c89bf2 (R2, adopted) and its finding about the fetch: a keyless founder in an ineligible
// workspace had the page fetched before the principal refused. Now the principal is read before any fetch; and after one
// read that was refused before any call, GET /api/usage still shows the trial funded with 3 scans; after a read whose
// call failed, it shows the money ceiling honestly (account_total_cap with 3 attempts left), never "scans used".
test('#444 probe R2 + pre-fetch principal: no read is attempted for an ineligible workspace; usage after a released read is unchanged, after a failed call it names the money ceiling', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw)
  const mk = async (n: number, email: string, personal = true) => {
    const id = uid(n)
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
    await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
    if (personal) await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1)", [id, id])
    return id
  }
  const post = async () => {
    const req = new NextRequest('http://localhost/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `198.51.100.${ip++}` }, body: JSON.stringify({ url: 'https://acme.example' }) })
    const r = await POST(req)
    return { status: r.status, body: await r.json() as { error?: string; trial?: string } }
  }
  const usage = async () => {
    const r = await usageGet(new NextRequest('http://localhost/api/usage', { headers: { host: 'localhost', 'x-forwarded-for': '198.51.100.250' } }))
    return ((await r.json()) as { trial: { funded: boolean; remaining: number; cap: number; blocked: string | null } }).trial
  }
  // 1. Ineligible workspaces: the FREE read still answers (main's floor - the fetch needs no key and no one's money),
  // with the reason the funded read was never tried; the trial side (admission, key, wallet) never runs.
  const F = await mk(61, 'f61@gmail.com'), M = await mk(62, 'm62@gmail.com'), NOROW = await mk(63, 'norow63@gmail.com', false)
  const before = calls.n
  const keysBefore = handedKeys.length
  setUser({ id: F, actorId: M, role: 'operator', business_name: 'b', email: 'm62@gmail.com' })
  let r = await post()
  assert.equal(r.status, 200, 'member acting')
  assert.equal((r.body as { free?: boolean }).free, true, 'member acting')
  assert.equal(r.body.trial, 'workspace_not_eligible', 'member acting')
  setUser({ id: NOROW, business_name: 'b', email: 'norow63@gmail.com' })
  r = await post()
  assert.equal(r.status, 200, 'no personal row')
  assert.equal(r.body.trial, 'workspace_not_eligible', 'no personal row')
  assert.equal(calls.n, before + 2, 'the free read ran for both')
  assert.equal(handedKeys.length, keysBefore, 'the operator key never left for an ineligible workspace')
  // 2. The founder, allowance $0.34: one $0.30 scan fits; a scan and a $0.05 read do not.
  const saved = process.env.DAZL_TRIAL_ACCOUNT_TOTAL_USD
  process.env.DAZL_TRIAL_ACCOUNT_TOTAL_USD = '0.34'
  try {
    setUser({ id: F, business_name: 'b', email: 'f61@gmail.com' })
    assert.deepEqual(await usage(), { funded: true, remaining: 3, cap: 3, blocked: null })
    // a read the guard refused before any call: released, nothing changes
    next.outcome = 'guard_refused'
    r = await post()
    assert.equal(r.status, 200); assert.equal(r.body.trial, 'spend_unavailable', JSON.stringify(r.body))
    assert.deepEqual(await usage(), { funded: true, remaining: 3, cap: 3, blocked: null }, 'a read refused before any call leaves the trial as it was')
    assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trial_reservations WHERE tenant_id = ?', [F]))!.n), 0)
    // a read whose call failed: its $0.05 stays on the account, so the money ceiling blocks a scan, and the counter says
    // so honestly: 3 attempts left, blocked by the allowance (lib/trial-copy.ts names the reads).
    next.outcome = 'call_failed'
    r = await post()
    assert.equal(r.status, 200); assert.equal(r.body.trial, 'read_failed', JSON.stringify(r.body))
    assert.deepEqual(await usage(), { funded: false, remaining: 3, cap: 3, blocked: 'account_total_cap' })
  } finally { if (saved === undefined) delete process.env.DAZL_TRIAL_ACCOUNT_TOTAL_USD; else process.env.DAZL_TRIAL_ACCOUNT_TOTAL_USD = saved }
  console.log('SITE_READ_ROUTE_PROBE ok')
})
