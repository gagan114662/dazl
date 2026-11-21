// #1319 item 3, through the REAL /api/auth/google (link start) and /api/auth/callback/google handlers on a temporary
// SQLite store. Only Google's own token and key endpoints are answered by a stub (no network), as in
// google-auth-route-runtime.mts. The Google account picked already signs in to ANOTHER dazl account ('taken'): the person
// goes back to the exact page they started from (onboarding step or search), and the result never shows in the address.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const SID = 'staging-signin-123.apps.googleusercontent.com', SSEC = 'GOCSPX-staging-only-secret'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (claims: Record<string, unknown>) => { const h = b({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), c = b(claims); return `${h}.${c}.${createSign('RSA-SHA256').update(`${h}.${c}`).sign(privateKey).toString('base64url')}` }
let nonce = '', idEmail = '', idSub = ''
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u)
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }))
  if (url === 'https://oauth2.googleapis.com/token') {
    const aud = new URLSearchParams(String(init?.body)).get('client_id')
    return new Response(JSON.stringify({ id_token: sign({ iss: 'https://accounts.google.com', aud, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: idSub, email: idEmail, email_verified: true, name: 'Pat' }) }))
  }
  throw new Error(`Unexpected network call ${url}`)
}) as typeof fetch

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'dazl-gtaken-')), 'app.db')
Object.assign(process.env, { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.ai', GOOGLE_SIGNIN_CLIENT_ID: SID, GOOGLE_SIGNIN_CLIENT_SECRET: SSEC })
const start = await import('../../app/api/auth/google/route.ts')
const callback = await import('../../app/api/auth/callback/google/route.ts')
const { getAuthDb } = await import('../../lib/db/sqlite-store.ts')
const { createPasswordUser, createSession } = await import('../../lib/auth-db.ts')
const { linkGoogleHref, readGoogleLinkResult, GOOGLE_LINK_RESULT_COOKIE } = await import('../../lib/google-link.ts')
let ip = 0
const BASE = 'https://staging.dazl.ai'
const req = (url: string, cookie?: string) => new NextRequest(url, { headers: { 'x-forwarded-for': `10.9.0.${++ip}`, 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) } })
const cookieOf = (r: Response, name: string) => r.headers.getSetCookie().find(c => c.startsWith(`${name}=`)) ?? ''

// The other dazl account that already signs in with the Google account the person picks.
await createPasswordUser({ id: 'OTHER', email: 'pat@example.test', name: 'O', business_name: 'O', password_hash: 'h', salt: 's' })
getAuthDb().prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'g-pat', 'OTHER')").run()
// The person: a password account (no Google yet), signed in just now, on the free-trial refusal.
await createPasswordUser({ id: 'ME', email: 'pat+dazl@example.test', name: 'M', business_name: 'M', password_hash: 'h', salt: 's' })
getAuthDb().prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'ME'").run()
const session = await createSession('ME')

// Click "Link Google" on `here` (the TrialRefusalNotice href), pick the Google account, come back through the callback.
async function linkFrom(here: string) {
  const s = await start.GET(req(`${BASE}${linkGoogleHref(here)}`))
  const set = s.headers.getSetCookie()
  const oauth = /dazl_oauth=([^;]+)/.exec(set.join('\n'))![1]
  const next = /dazl_link_next=([^;]*)/.exec(set.join('\n'))?.[1] ?? ''
  nonce = oauth.split('.')[1]; idEmail = 'pat@example.test'; idSub = 'g-pat'
  const r = await callback.GET(req(`${BASE}/api/auth/callback/google?code=t&state=${oauth.split('.')[0]}`, `dazl_oauth=${oauth}; dazl_return=link${next ? `; dazl_link_next=${next}` : ''}; dazl_session=${session}`))
  return r
}

for (const [where, here] of [
  ['onboarding (Home first-run steps)', '/app?setup=brain'],
  ['a search on Leads', '/app/leads?q=Small%20marketing%20and%20creative%20agencies%20in%20Toronto%2C%20Ontario%20-%20hiring%20an%20SDR'],
] as const) {
  test(`#1319 item 3: Google account taken, started from ${where}: back to that exact page, with no 'taken' in the address`, async () => {
    const r = await linkFrom(here)
    assert.equal((getAuthDb().prepare("SELECT user_id FROM oauth_identities WHERE subject = 'g-pat'").get() as { user_id: string } | undefined)?.user_id, 'OTHER', 'nothing was linked')
    const loc = new URL(r.headers.get('location')!)
    assert.equal(loc.origin, BASE)
    assert.equal(loc.pathname + loc.search, here, 'the page they started from, as it was')
    assert.doesNotMatch(r.headers.get('location')!, /taken|google=/, 'the result is not in the visible URL')
    // the result travels to that page once, in a short-lived cookie only /app pages read; the page shows the plain message
    const c = cookieOf(r, GOOGLE_LINK_RESULT_COOKIE)
    assert.match(c, new RegExp(`^${GOOGLE_LINK_RESULT_COOKIE}=taken;`), c)
    assert.match(c, /Path=\/app/i); assert.match(c, /Max-Age=\d{1,3};/i); assert.doesNotMatch(c, /HttpOnly/i, 'the page reads it, then clears it')
    const shown = readGoogleLinkResult({ search: loc.search, cookie: `other=1; ${c.split(';')[0]}` })
    assert.deepEqual(shown, { result: { ok: false, text: 'That Google account already signs in to another dazl account. Pick a different Google account, the one for this account\'s email.' }, search: loc.search })
  })
}

test('#1319 item 3: a search whose query cannot travel as the return page (too long, or characters refused) still returns to that page, not Settings', async () => {
  const long = `/app/leads?q=${encodeURIComponent(`Independent agencies (design, brand & web) in Toronto that posted an SDR role - ${'x'.repeat(200)}`)}`
  const r = await linkFrom(long)
  const loc = new URL(r.headers.get('location')!)
  assert.equal(loc.pathname, '/app/leads', 'the Leads page the search was on (its search is restored from the saved pending search)')
  assert.doesNotMatch(r.headers.get('location')!, /settings|taken|google=/)
})

test('#1319 item 3: an old ?google= address still reads once and is removed; no result, nothing shown', () => {
  assert.deepEqual(readGoogleLinkResult({ search: '?job_id=abc&google=taken', cookie: '' }), { result: { ok: false, text: 'That Google account already signs in to another dazl account. Pick a different Google account, the one for this account\'s email.' }, search: '?job_id=abc' })
  assert.deepEqual(readGoogleLinkResult({ search: '?job_id=abc', cookie: 'a=b' }), { result: null, search: '?job_id=abc' })
})
