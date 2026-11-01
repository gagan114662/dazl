// Runs the REAL preview-claim routes and the Google callback's preview branch (#416) against a temporary SQLite
// database, with Google's token and key endpoints stubbed (no network). Covers: the validating start route's
// cookies, the full claim-through-Google round trip, a foreign-recipient refusal, and the POST claim route's
// CSRF/auth/atomicity behavior.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (claims: Record<string, unknown>) => { const h = b({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), c = b(claims); return `${h}.${c}.${createSign('RSA-SHA256').update(`${h}.${c}`).sign(privateKey).toString('base64url')}` }
let nonce = '', idEmail = 'pat@example.test', idSub = 'g-1'
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u)
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }))
  if (url === 'https://oauth2.googleapis.com/token') {
    const aud = new URLSearchParams(String(init?.body)).get('client_id')
    return new Response(JSON.stringify({ id_token: sign({ iss: 'https://accounts.google.com', aud, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: idSub, email: idEmail, email_verified: true, name: 'Pat' }) }))
  }
  throw new Error(`Unexpected network call ${url}`)
}) as typeof fetch

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'dazl-claim-')), 'app.db')
const MASTER = randomBytes(32)
const ENV = { PUBLIC_BASE_URL: 'https://app.test', GOOGLE_CLIENT_ID: 'p', GOOGLE_CLIENT_SECRET: 'pp', DAZL_MASTER_KEY: MASTER.toString('base64') }
Object.assign(process.env, ENV)

const start = await import('../../app/api/auth/google/route.ts')
const callback = await import('../../app/api/auth/callback/google/route.ts')
const previewGoogle = await import('../../app/api/preview/[token]/google/route.ts')
const claimRoute = await import('../../app/api/preview/claim/route.ts')
const { getAuthDb, createPasswordUser, createSession } = await import('../../lib/auth-db.ts')
const { migrateScan, createJob } = await import('../../lib/scan/store.ts')
const { migratePreviewClaim } = await import('../../lib/scan/preview-claim.ts')
const { migratePlatform } = await import('../../lib/db/platform-tables.ts')
const { sqliteDb } = await import('../../lib/db/client.ts')
const { issuePreviewClaim, readPublicClaim } = await import('../../lib/scan/preview-claim.ts')
const { withJar } = await import('./pg-session-headers.ts')

let ip = 0
const req = (url: string, cookie?: string) => new NextRequest(url, { headers: { 'x-forwarded-for': `10.9.0.${++ip}`, ...(cookie ? { cookie } : {}) } })
const NOW = Date.UTC(2026, 9, 31)
const OFFER = { text: 'Appointment reminders for physiotherapy clinics', sourceUrl: 'https://prospect-clinicsoft.test/about' }

const h = getAuthDb()
migrateScan(h)
migratePreviewClaim(h)
migratePlatform(h)
// rate limits use the async db client over the same file: its tables come from the same migrates above
const issueFor = async (email: string) => {
  const jobId = createJob(h, 'seller1', { business_name: 'Seller Co', industry: 'x', location: 'y' })
  h.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  const day = new Date(NOW - 10 * 86400_000).toISOString().slice(0, 10)
  h.prepare('INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, confidence, score, event_date, date_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomBytes(6).toString('hex'), jobId, 'Northside Physio', 'Opened a second clinic', 'https://news.test/a1', 'We opened our second clinic this month.', 80, 70, day, 'verified')
  h.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(NOW, jobId)
  const r = await issuePreviewClaim(sqliteDb(h), MASTER, { runId: jobId, sellerTenantId: 'seller1', recipientEmail: email, business: 'Clinic Soft', inferredOffer: OFFER, spendUsd: 0.42 }, NOW)
  if (!r || r.status !== 'issued') throw new Error('setup: ' + JSON.stringify(r))
  return r
}

test('the start route sets a host-only short claim intent from a validated row, and refuses unknown tokens', async () => {
  const r0 = await issueFor('pat@example.test')
  const bad = await previewGoogle.GET(req(`https://app.test/api/preview/${'1'.repeat(32)}.${'2'.repeat(32)}/google`), { params: Promise.resolve({ token: `${'1'.repeat(32)}.${'2'.repeat(32)}` }) })
  assert.equal(new URL(bad.headers.get('location')!).pathname.startsWith('/preview/'), true, 'unknown token never reaches Google')
  const malformed = await previewGoogle.GET(req('https://app.test/api/preview/junk/google'), { params: Promise.resolve({ token: 'junk' }) })
  assert.equal(new URL(malformed.headers.get('location')!).pathname, '/sign-in')
  const r = await previewGoogle.GET(req(`https://app.test/api/preview/${r0.token}/google`), { params: Promise.resolve({ token: r0.token }) })
  assert.equal(r.status, 307)
  assert.equal(new URL(r.headers.get('location')!).pathname, '/api/auth/google', 'server-chosen destination, never an input URL')
  const set = r.headers.getSetCookie()
  const claim = set.find(c => /^dazl_claim=/.test(c))!
  for (const a of [/^dazl_claim=[a-f0-9]{32}\.[a-f0-9]{32};/, /Max-Age=3600/, /Path=\/api\/auth/, /Secure/, /HttpOnly/, /SameSite=lax/i]) assert.match(claim, a)
  assert.doesNotMatch(claim, /Domain=/i, 'host-only intent cookie')
  assert.ok(set.some(c => /^dazl_return=preview;/.test(c)))
  console.log('PREVIEW_START_OK')
})

test('a full claim through Google: signed in, claimed atomically, landed on the private route, cookies cleared', async () => {
  const r0 = await issueFor('pat@example.test')
  const s = await start.GET(req('https://app.test/api/auth/google'))
  const cookie = /dazl_oauth=([^;]+)/.exec(s.headers.get('set-cookie')!)![1]
  const [state, n] = cookie.split('.'); nonce = n
  const r = await callback.GET(req(`https://app.test/api/auth/callback/google?code=c&state=${state}`, `dazl_oauth=${cookie}; dazl_return=preview; dazl_claim=${r0.token}`))
  const loc = new URL(r.headers.get('location')!)
  assert.match(loc.pathname, /^\/app\/preview\/[a-f0-9]{32}$/, 'landed on the stable private claimed route')
  const set = r.headers.getSetCookie()
  assert.ok(set.some(c => /^dazl_session=[0-9a-f]{64};/.test(c)))
  assert.ok(set.some(c => /^dazl_claim=;.*Max-Age=0/.test(c)), 'intent cookie cleared')
  assert.ok(set.some(c => /^dazl_return=;.*Max-Age=0/.test(c)))
  const uid = (h.prepare("SELECT id FROM users WHERE email = 'pat@example.test'").get() as { id: string }).id
  const row = h.prepare('SELECT claimed_by_tenant FROM preview_claims WHERE id = ?').get(r0.id) as { claimed_by_tenant: string }
  assert.equal(row.claimed_by_tenant, uid, 'claimed by the new account’s own workspace')
  assert.equal((await readPublicClaim(sqliteDb(h), MASTER, r0.token)).status, 'claimed', 'public content revoked')
  console.log('PREVIEW_GOOGLE_CLAIM_OK')
})

test('a claim meant for someone else is refused at the callback and stays unclaimed', async () => {
  const r0 = await issueFor('someone-else@example.test')
  const s = await start.GET(req('https://app.test/api/auth/google'))
  const cookie = /dazl_oauth=([^;]+)/.exec(s.headers.get('set-cookie')!)![1]
  const [state, n] = cookie.split('.'); nonce = n
  const r = await callback.GET(req(`https://app.test/api/auth/callback/google?code=c&state=${state}`, `dazl_oauth=${cookie}; dazl_return=preview; dazl_claim=${r0.token}`))
  const loc = new URL(r.headers.get('location')!)
  assert.equal(loc.pathname, `/preview/${r0.token}`)
  assert.equal(loc.searchParams.get('e'), 'foreign')
  assert.equal((h.prepare('SELECT claimed_at FROM preview_claims WHERE id = ?').get(r0.id) as { claimed_at: number | null }).claimed_at, null)
  console.log('PREVIEW_FOREIGN_OK')
})

test('the POST claim route: CSRF, auth, atomic claim, idempotent resume, unverified prompt', async () => {
  await createPasswordUser({ id: 'U1', email: 'webb@example.test', name: 'W', business_name: 'W', password_hash: 'h', salt: 's' })
  const session = await createSession('U1')
  const r0 = await issueFor('webb@example.test')
  const post = (body: string, type = 'application/json') => withJar(new Map([['dazl_session', session]]), () =>
    claimRoute.POST(new NextRequest('https://app.test/api/preview/claim', { method: 'POST', headers: { 'content-type': type, origin: 'https://app.test', host: 'app.test', 'x-forwarded-for': `10.9.1.${++ip}` }, body })))
  const csrf = await post(JSON.stringify({ token: r0.token }), 'text/plain')
  assert.equal(csrf.status, 403, 'non-JSON write refused')
  assert.equal((h.prepare('SELECT claimed_at FROM preview_claims WHERE id = ?').get(r0.id) as { claimed_at: number | null }).claimed_at, null, 'a refused request never claims')
  const bad = await post(JSON.stringify({ token: 'junk' }))
  assert.equal(bad.status, 404)
  const unverified = await post(JSON.stringify({ token: r0.token }))
  assert.equal(unverified.status, 403)
  assert.equal((await unverified.json()).code, 'unverified', 'password account must verify its email first')
  h.prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'U1'").run()
  const ok = await post(JSON.stringify({ token: r0.token }))
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true, id: r0.id })
  const again = await post(JSON.stringify({ token: r0.token }))
  assert.equal(again.status, 200, 'a refresh-resume is not an error')
  const signedOut = await withJar(new Map(), () => claimRoute.POST(new NextRequest('https://app.test/api/preview/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.2.1' }, body: JSON.stringify({ token: r0.token }) })))
  assert.equal(signedOut.status, 401)
  console.log('PREVIEW_CLAIM_ROUTE_OK')
})
