// Postgres port, auth area (#354): the real sign-up, verification, reset, sign-in and Google callback handlers, run on
// SQLite and on a Postgres-only fixture from the same seed. Each one reaches the #417 conversion boundary (queue a
// pending conversion, activate it, stop the queued acquisition work, enroll the opted-in onboarding path); every
// response and every row those writes leave must be identical on both engines, up to random ids and clock times.
// On Postgres there is no SQLite at all: DB_PATH points nowhere (getAuthDb() cannot open) and getScanDb is trapped, so
// a route still reaching for the raw handle fails, and a captured lifecycle error fails the run too.
// Synthetic data only; mail is captured in-process and Google's endpoints are stubs. Any other fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, trapScanDb } from './tenant-route-db.ts'
import { withJar } from './pg-session-headers.ts'
import { getDb, setDb, sqliteDb, pgDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { setErrorSinks, type ErrorRecord } from '../../lib/ops/errors.ts'
import { ONBOARDING_POLICY_VERSION } from '../../lib/outreach/onboarding-policy.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

process.env.DB_PATH = '/nonexistent-dazl-dir/app.db' // getAuthDb() cannot open: any raw access fails
const SID = 'staging-signin-123.apps.googleusercontent.com'
Object.assign(process.env, { SYSTEM_MAIL_SMTP_URL: 'smtp://fixture.invalid', SYSTEM_MAIL_FROM: 'fixture@example.test',
  DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.ai', GOOGLE_SIGNIN_CLIENT_ID: SID, GOOGLE_SIGNIN_CLIENT_SECRET: 'GOCSPX-staging-only-secret' })
delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET

// Google, stubbed: the token endpoint answers with an ID token signed by a local key for the identity under test.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (claims: Record<string, unknown>) => { const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), c = b64(claims); return `${h}.${c}.${createSign('RSA-SHA256').update(`${h}.${c}`).sign(privateKey).toString('base64url')}` }
let nonce = '', idEmail = '', idSub = ''
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u)
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }))
  if (url === 'https://oauth2.googleapis.com/token') {
    const aud = new URLSearchParams(String(init?.body)).get('client_id')
    return new Response(JSON.stringify({ id_token: sign({ iss: 'https://accounts.google.com', aud, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: idSub, email: idEmail, email_verified: true, name: 'Gia' }) }))
  }
  throw new Error(`Unexpected network call ${url}`)
}) as typeof fetch

const mails: { to: string; text: string }[] = []
const { setTransportForTests } = await import('../../lib/system-mail.ts')
setTransportForTests(async m => { mails.push({ to: m.to, text: m.text }) })
const errors: ErrorRecord[] = []
setErrorSinks([r => { errors.push(r) }])

const signup = await import('../../app/api/auth/signup/route.ts')
const verify = await import('../../app/api/auth/verify/route.ts')
const resetRequest = await import('../../app/api/auth/reset/request/route.ts')
const reset = await import('../../app/api/auth/reset/route.ts')
const signin = await import('../../app/api/auth/signin/route.ts')
const googleStart = await import('../../app/api/auth/google/route.ts')
const googleCallback = await import('../../app/api/auth/callback/google/route.ts')

let ip = 0
const post = (path: string, body: unknown) => new NextRequest(`https://staging.dazl.ai${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'staging.dazl.ai', origin: 'https://staging.dazl.ai', 'x-forwarded-for': `10.54.${Math.floor(++ip / 250)}.${ip % 250}` }, body: JSON.stringify(body) })
const get = (url: string, cookie?: string) => new NextRequest(url, { headers: { 'x-forwarded-for': `10.55.0.${++ip % 250}`, ...(cookie ? { cookie } : {}) } })
const link = (to: string, path: string) => mails.filter(m => m.to === to).map(m => new RegExp(`/${path}#t=([a-f0-9]{64})`).exec(m.text)?.[1]).filter(Boolean).at(-1)

const T = 'tenantT_seller', T0 = 1_790_000_000
const STARTED = Math.floor(Date.now() / 1000) - 5
const BODY = 'bodybodybodybodybodybody'
const SEEDED_EMAILS = ['pat@example.test', 'rob@example.test', 'dee@example.test', 'gia@example.test', 'safe@example.test']

async function seed(db: Db): Promise<void> {
  await db.run("INSERT INTO users (id, email, password_hash, salt, business_name, created_at) VALUES (?, 'seller@example.test', 'h', 's', 'Seller Co', ?)", [T, T0])
  await db.run('INSERT INTO onboarding_policies (tenant_id, policy_version, opted_in_by, opted_in_at, withdrawn_at) VALUES (?, ?, ?, ?, NULL)', [T, ONBOARDING_POLICY_VERSION, T, T0])
  const job = 'a1'.repeat(12)
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, created_at) VALUES (?, ?, 'Seller Co', 'dental', 'Toronto', 'q', ?)", [job, T, T0])
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  for (const [i, email] of SEEDED_EMAILS.entries()) {
    // Queued automated acquisition work addressed to each prospect: a scheduler-held first touch and an active sequence.
    const lead = `b${i}`.repeat(12)
    await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, contact, created_at) VALUES (?, ?, 'P', ?, 'Hiring', 'https://n.example/a', 80, ?, ?)", [lead, job, `Co ${i}`, email, T0])
    await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES (?, ?, ?, ?, 'hi', ?, 'draft', 'warmup_manual', 1800000100)", [`m-${i}`, T, lead, email, BODY])
    await db.run("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, ?, ?, ?, ?, 'active')", [`sq-${i}`, T, lead, `m-${i}`, email])
  }
}

type Out = { name: string; status: number; body: unknown }
async function call(name: string, res: Response | Promise<Response>): Promise<Out> {
  const r = await res
  const loc = r.headers.get('location')
  if (loc) return { name, status: r.status, body: { location: loc } }
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { name, status: r.status, body }
}

// Random ids become stable tokens in order of first appearance; times the writes take from the clock become 'now'.
function normalizer() {
  const seen = new Map<string, string>()
  const walk = (v: unknown, k = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x, k))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, walk(x, kk)]))
    if (typeof v === 'string' && v !== T && /^[0-9a-f]{24,}$/.test(v)) { if (!seen.has(v)) seen.set(v, `rand#${seen.size}`); return seen.get(v) }
    if (typeof v === 'number' && /_at$/.test(k) && v >= STARTED) return 'now'
    return v
  }
  return walk
}

async function scenario(db: Db): Promise<{ out: Out[]; rows: Record<string, unknown> }> {
  const out: Out[] = []
  mails.length = 0
  const strong = (n: number) => `a strong password ${n}`
  // 1. an unverified password sign-up queues a PENDING conversion only; its verification link activates it.
  out.push(await call('signup pat', withJar(new Map(), () => signup.POST(post('/api/auth/signup', { email: 'pat@example.test', password: strong(1), name: 'Pat', business_name: 'Pat Co' })))))
  const pendingAfterSignup = await db.all("SELECT kind, activated_at FROM lifecycle_events WHERE email = 'pat@example.test'")
  const patWorkAfterSignup = await db.get("SELECT status FROM outreach_messages WHERE id = 'm-0'")
  const tv = link('pat@example.test', 'verify')
  assert.ok(tv, 'a verification link went to the address')
  out.push(await call('verify pat', verify.POST(post('/api/auth/verify', { token: tv }))))
  out.push(await call('verify replay', verify.POST(post('/api/auth/verify', { token: tv }))))
  // 2. a reset link proves ownership too.
  out.push(await call('signup rob', withJar(new Map(), () => signup.POST(post('/api/auth/signup', { email: 'rob@example.test', password: strong(2), name: 'Rob', business_name: 'Rob Co' })))))
  out.push(await call('reset request rob', resetRequest.POST(post('/api/auth/reset/request', { email: 'rob@example.test' }))))
  const tr = link('rob@example.test', 'reset')
  assert.ok(tr, 'a reset link went to the address')
  out.push(await call('reset rob', reset.POST(post('/api/auth/reset', { token: tr, password: strong(3) }))))
  // 3. a verified sign-in re-drains a conversion whose activation was lost.
  const salt = randomBytes(16).toString('hex')
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, email_verified_at) VALUES ('userD_fixture', 'dee@example.test', 'D', 'D Co', ?, ?, 100)", [scryptSync(strong(4), salt, 64).toString('hex'), salt])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES ('userD_fixture', 'D Co', 'personal', 'userD_fixture', ?)", [T0])
  await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('userD_fixture', 'userD_fixture', 'owner', ?)", [T0])
  await db.run("INSERT INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES ('signup|dee@example.test', 'signup', 'dee@example.test', 'userD_fixture', ?, NULL)", [T0])
  out.push(await call('signin dee wrong password', withJar(new Map(), () => signin.POST(post('/api/auth/signin', { email: 'dee@example.test', password: strong(5) })))))
  const deeBeforeSignin = await db.get("SELECT status FROM outreach_messages WHERE id = 'm-2'")
  const jar = new Map<string, string>()
  out.push(await call('signin dee', withJar(jar, () => signin.POST(post('/api/auth/signin', { email: 'dee@example.test', password: strong(4) })))))
  out.push({ name: 'signin dee cookie', status: 0, body: /^[a-f0-9]{64}$/.test(jar.get('dazl_session') ?? '') })
  // 4. a new Google account is a verified conversion at creation.
  const s = await googleStart.GET(get('https://staging.dazl.ai/api/auth/google'))
  const cookie = /dazl_oauth=([^;]+)/.exec(s.headers.get('set-cookie') ?? '')?.[1]
  assert.ok(cookie, 'the Google start route set its one-time cookie')
  const [state, n] = cookie.split('.'); nonce = n; idEmail = 'gia@example.test'; idSub = 'g-gia'
  out.push(await call('google gia', googleCallback.GET(get(`https://staging.dazl.ai/api/auth/callback/google?code=the-code&state=${state}`, `dazl_oauth=${cookie}`))))
  // 5. tampered and unknown links activate nothing.
  out.push(await call('verify tampered', verify.POST(post('/api/auth/verify', { token: 'f'.repeat(64) }))))
  out.push(await call('reset tampered', reset.POST(post('/api/auth/reset', { token: 'e'.repeat(64), password: strong(6) }))))
  const rows = {
    pendingAfterSignup, patWorkAfterSignup, deeBeforeSignin,
    events: await db.all('SELECT event_key, kind, email, account_tenant, activated_at FROM lifecycle_events ORDER BY event_key'),
    messages: await db.all('SELECT id, status, error, hold_reason FROM outreach_messages ORDER BY id'),
    sequences: await db.all('SELECT id, status, stop_reason FROM sequences ORDER BY id'),
    enrollments: await db.all('SELECT tenant_id, email, source FROM onboarding_enrollments ORDER BY email'),
    stopAudit: await db.all("SELECT tenant_id, lead_id, action, detail FROM autopilot_audit WHERE action = 'sequence_stopped' ORDER BY lead_id"),
    users: await db.all('SELECT email, CASE WHEN email_verified_at IS NULL THEN 0 ELSE 1 END AS verified FROM users ORDER BY email'),
  }
  return normalizer()({ out, rows }) as { out: Out[]; rows: Record<string, unknown> }
}

const lifecycleErrors = () => errors.filter(e => /lifecycle/.test(String(e.where)))

async function onSqlite() {
  errors.length = 0
  const lite = new Database(':memory:')
  migrateAllSqlite(lite)
  setScanDb(lite) // getScanDb and getDb both see this store, as in the app
  await seed(sqliteDb(lite))
  return scenario(sqliteDb(lite))
}

async function onPg() {
  errors.length = 0
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    trapScanDb() // getScanDb() now throws: Postgres deployments have no raw SQLite handle
    setDb(pg)
    assert.equal((await getDb()).kind, 'pg', 'engine canary: the route-facing store IS Postgres')
    await seed(pg)
    return await scenario(pg)
  } finally { await pg.close(); await s.drop() }
}

const by = (out: Out[], n: string) => out.find(o => o.name === n)!
type Rows = { pendingAfterSignup: unknown; patWorkAfterSignup: unknown; deeBeforeSignin: unknown; events: { email: string; kind: string; activated_at: unknown }[]; messages: { id: string; status: string; error: string | null }[]; sequences: { id: string; status: string }[]; enrollments: unknown[] }

function checkFlow(r: { out: Out[]; rows: Record<string, unknown> }, engine: string) {
  const o = (n: string) => by(r.out, n)
  const rows = r.rows as unknown as Rows
  assert.deepEqual(lifecycleErrors().map(e => `${e.where}: ${e.error.message}`), [], `${engine}: no conversion step failed`)
  assert.equal(o('signup pat').status, 200)
  assert.deepEqual(rows.pendingAfterSignup, [{ kind: 'signup', activated_at: null }], `${engine}: the unverified sign-up queued a pending conversion`)
  assert.deepEqual(rows.patWorkAfterSignup, { status: 'draft' }, `${engine}: an unverified typed email cancels nothing`)
  assert.deepEqual(o('verify pat').body, { ok: true })
  assert.equal(o('verify replay').status, 410)
  assert.deepEqual([o('signup rob').status, o('reset request rob').status, o('reset rob').status], [200, 200, 200])
  assert.equal(o('signin dee wrong password').status, 401)
  assert.deepEqual(rows.deeBeforeSignin, { status: 'draft' }, `${engine}: a refused sign-in drains nothing`)
  assert.deepEqual([o('signin dee').status, o('signin dee cookie').body], [200, true])
  assert.equal((o('google gia').body as { location: string }).location, 'https://staging.dazl.ai/app')
  assert.deepEqual([o('verify tampered').status, o('reset tampered').status], [410, 410])
  const msg = Object.fromEntries(rows.messages.map(m => [m.id, `${m.status}:${m.error ?? ''}`]))
  assert.deepEqual(msg, { 'm-0': 'skipped:converted_signup', 'm-1': 'skipped:converted_activation', 'm-2': 'skipped:converted_signup', 'm-3': 'skipped:converted_signup', 'm-4': 'draft:' }, `${engine}: queued work stopped for the four proven addresses, not the untouched one`)
  assert.deepEqual(rows.sequences.map(s => `${s.id}:${s.status}`), ['sq-0:stopped', 'sq-1:stopped', 'sq-2:stopped', 'sq-3:stopped', 'sq-4:active'])
  const ev = rows.events.map(e => `${e.kind}|${e.email}|${e.activated_at === 'now' || typeof e.activated_at === 'number' ? 'active' : 'pending'}`)
  assert.deepEqual(ev, ['activation|rob@example.test|active', 'signup|dee@example.test|active', 'signup|gia@example.test|active', 'signup|pat@example.test|active', 'signup|rob@example.test|active'])
  // rob's reset records the activation first, which stops the work and enrolls; the signup it then activates finds nothing left
  assert.deepEqual(rows.enrollments, [['dee', 'signup'], ['gia', 'signup'], ['pat', 'signup'], ['rob', 'activation']].map(([n, k]) => ({ tenant_id: T, email: `${n}@example.test`, source: `conversion:${k}` })), `${engine}: the opted-in seller's onboarding path, once per address`)
}

test('auth routes on SQLite: sign-up, verification, reset, sign-in and Google reach the conversion boundary', async () => {
  checkFlow(await onSqlite(), 'sqlite')
})

// The same flow on SQLite with the raw handle trapped (getScanDb throws; getDb still serves the store): the routes reach
// the conversion boundary through the Db layer only. Runs without Postgres; before the port every step here failed.
test('auth routes with getScanDb trapped: nothing in the flow needs the raw SQLite handle', async () => {
  errors.length = 0
  const lite = new Database(':memory:')
  migrateAllSqlite(lite)
  setScanDb(lite)
  trapScanDb()
  await seed(sqliteDb(lite))
  checkFlow(await scenario(sqliteDb(lite)), 'sqlite, raw handle trapped')
})

// The conversion step is best-effort by design: a store failure there is captured with its route, and the sign-in or
// verification still succeeds (the pending rows are durable). An unawaited rejection would escape the capture.
test('a failing conversion step is captured and never blocks sign-in, sign-up or verification', async () => {
  errors.length = 0; mails.length = 0
  const lite = new Database(':memory:')
  migrateAllSqlite(lite)
  setScanDb(lite)
  trapScanDb()
  const db = sqliteDb(lite)
  const salt = randomBytes(16).toString('hex')
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, email_verified_at) VALUES ('userE_fixture', 'eve@example.test', 'E', 'E Co', ?, ?, 100)", [scryptSync('a strong password 7', salt, 64).toString('hex'), salt])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES ('userE_fixture', 'E Co', 'personal', 'userE_fixture', ?)", [T0])
  await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('userE_fixture', 'userE_fixture', 'owner', ?)", [T0])
  lite.exec('DROP TABLE lifecycle_events') // the conversion store is gone
  const jar = new Map<string, string>()
  const si = await withJar(jar, () => signin.POST(post('/api/auth/signin', { email: 'eve@example.test', password: 'a strong password 7' })))
  assert.equal(si.status, 200)
  assert.match(jar.get('dazl_session') ?? '', /^[a-f0-9]{64}$/)
  const su = await withJar(new Map(), () => signup.POST(post('/api/auth/signup', { email: 'fay@example.test', password: 'a strong password 8', name: 'F', business_name: 'F Co' })))
  assert.equal(su.status, 200)
  const tv = link('fay@example.test', 'verify')
  assert.deepEqual(await (await verify.POST(post('/api/auth/verify', { token: tv }))).json(), { ok: true })
  assert.deepEqual(lifecycleErrors().map(e => e.where), ['/api/auth/signin:lifecycle', '/api/auth/signup:lifecycle', '/api/auth/verify:lifecycle'])
})

test('auth routes on a Postgres-only fixture: identical responses and writes; no SQLite handle anywhere', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const sqlite = await onSqlite()
  const pg = await onPg()
  checkFlow(pg, 'pg')
  for (const [i, o] of sqlite.out.entries()) assert.deepEqual(pg.out[i], o, `${o.name}: Postgres answered differently`)
  assert.deepEqual(pg.rows, sqlite.rows, 'rows after the writes differ')
  console.log('AUTH ROUTES IDENTICAL ON POSTGRES')
})
