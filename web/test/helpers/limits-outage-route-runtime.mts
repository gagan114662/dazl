// API behaviour for #356, through the REAL handlers: the store answers reads but refuses writes (a partial outage), so
// the shared rate limits cannot be checked. Sign-in, sign-up, Google sign-in and scans must refuse with 503
// limits_unavailable and Retry-After, create nothing (no session, no user, no job, no trial reservation) and call no
// provider; after recovery they work again. Synthetic data only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser } from '../../lib/auth-db.ts'
import { sqliteDb } from '../../lib/db/client.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('network fenced') }) as typeof fetch
console.error = () => {}
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://app.example.test', GOOGLE_SIGNIN_CLIENT_ID: 'synthetic.apps.googleusercontent.com', GOOGLE_SIGNIN_CLIENT_SECRET: 'synthetic' })
const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
const salt = 'ab'.repeat(16)
await createPasswordUser({ id: 'U1', email: 'pat@example.test', name: 'Pat', business_name: 'Acme', password_hash: scryptSync('correct horse battery', salt, 64).toString('hex'), salt }, sqliteDb(raw))
const signin = (await import('../../app/api/auth/signin/route.ts')).POST
const signup = (await import('../../app/api/auth/signup/route.ts')).POST
const google = (await import('../../app/api/auth/google/route.ts')).GET
const scan = (await import('../../app/api/scan/route.ts')).POST
let ip = 0
const json = (url: string, body: unknown) => new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', host: 'app.example.test', origin: 'https://app.example.test', 'x-forwarded-for': `10.9.0.${++ip}` }, body: JSON.stringify(body) })
const count = (t: string) => (raw.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n
const unavailable = async (r: Response) => {
  assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '30')
  assert.equal(((await r.json()) as { code: string }).code, 'limits_unavailable')
  assert.equal(r.headers.get('set-cookie'), null, 'no session or cookie')
}

test('partial outage: sign-in, sign-up, Google sign-in and scans refuse with 503 and create nothing', async () => {
  const before = { sessions: count('sessions'), users: count('users'), jobs: count('scan_jobs') }
  raw.pragma('query_only = ON')
  try {
    await unavailable(await signin(json('https://app.example.test/api/auth/signin', { email: 'pat@example.test', password: 'correct horse battery' })))
    await unavailable(await signup(json('https://app.example.test/api/auth/signup', { email: 'new@example.test', password: 'another long password', name: 'N', business_name: 'B' })))
    const g = await google(new NextRequest('https://app.example.test/api/auth/google', { headers: { 'x-forwarded-for': '10.9.1.1' } }))
    assert.equal(g.headers.get('location'), 'https://app.example.test/sign-in?error=unavailable')
    assert.match(g.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(g.headers.get('set-cookie'), null, 'no OAuth state cookie')
    setUser({ id: 'U1', business_name: 'Acme' })
    await unavailable(await scan(json('https://app.example.test/api/scan', { query: 'Independent dental practices in New York hiring a receptionist in the past 90 days' })))
  } finally { raw.pragma('query_only = OFF') }
  assert.deepEqual({ sessions: count('sessions'), users: count('users'), jobs: count('scan_jobs') }, before)
  assert.equal(count('rate_limits'), 0, 'refused calls are not counted')
  assert.equal(fetches, 0, 'zero provider calls')
})

test('recovery: once the store answers again, sign-in is checked again (a wrong password is a 401, not a 503) and counted', async () => {
  const r = await signin(json('https://app.example.test/api/auth/signin', { email: 'pat@example.test', password: 'wrong password here' }))
  assert.equal(r.status, 401)
  assert.equal(count('rate_limits'), 2, 'the per-IP and per-account limits counted this attempt')
  assert.equal(fetches, 0)
  console.log('LIMITS_OUTAGE_ROUTES_OK')
})
