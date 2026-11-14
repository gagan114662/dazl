// #1116: the sign-up form posted NATIVELY (its script never hydrated it: slow, failed or stale bundle, or no JavaScript).
// The real route answers a form-encoded post with a redirect that says what happened, creates the account exactly as the
// scripted path does, never puts a field value in a URL, and refuses a cross-site or Origin-less form. No mail leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { signUpFormError, SIGN_UP_FORM_ERRORS } from '../../lib/signup-form-fallback.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.SYSTEM_MAIL_SMTP_URL = 'smtp://fixture.invalid'; process.env.SYSTEM_MAIL_FROM = 'fixture@example.test'
const { setTransportForTests } = await import('../../lib/system-mail.ts')
const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
const sentTo: string[] = []
setTransportForTests(async m => { sentTo.push(m.to) })
const signup = await import('../../app/api/auth/signup/route.ts')

let ip = 0
const FIELDS = { name: 'Dana Lee', email: 'dana@fixture-1116.test', business_name: 'Fixture Co', password: 'fixture-pass-1116-a1' }
const formReq = (fields: Record<string, string>, headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.11.0.${++ip}`, ...headers }, body: new URLSearchParams(fields).toString() })
const users = () => (raw.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n
const noValues = (loc: string, fields: Record<string, string>) => { for (const v of Object.values(fields)) assert.equal(decodeURIComponent(loc).includes(v), false, `no field value in the redirect address: ${loc}`) }

test('#1116 a native form post creates the account and redirects to "check your email", with no field value in the address', async () => {
  const res = await signup.POST(formReq(FIELDS))
  assert.equal(res.status, 303, 'a 303, so a reload never re-posts the form')
  const loc = res.headers.get('location')!
  assert.equal(loc, '/sign-up?sent=1', 'a relative address: the browser resolves it against the site it posted to, never the server\'s internal origin')
  noValues(loc, FIELDS)
  const u = raw.prepare('SELECT email, name, business_name FROM users WHERE email = ?').get(FIELDS.email) as { email: string; name: string; business_name: string } | undefined
  assert.deepEqual(u, { email: FIELDS.email, name: 'Dana Lee', business_name: 'Fixture Co' }, 'the account is made from the posted fields, as the scripted form makes it')
  assert.deepEqual(sentTo, [FIELDS.email], 'the confirmation link is sent')
})

test('#1116 native post errors come back as a code, never the values; nothing is created', async () => {
  const before = users()
  for (const [fields, code] of [[{ ...FIELDS, email: 'not-an-email' }, 'email'], [{ ...FIELDS, email: 'p@fixture-1116.test', password: 'short' }, 'password'], [{ ...FIELDS, email: 'q@fixture-1116.test', password: 'lettersonlylong' }, 'password']] as const) {
    const res = await signup.POST(formReq(fields))
    assert.equal(res.status, 303)
    const loc = res.headers.get('location')!
    assert.equal(loc, `/sign-up?error=${code}`); noValues(loc, fields)
  }
  assert.equal(users(), before, 'no account from a refused post')
  // the page's words for each code; an unknown or hostile code says nothing
  assert.equal(signUpFormError('email'), 'Enter a valid email address'); assert.match(signUpFormError('password'), /10 or more characters/)
  assert.equal(signUpFormError('<script>'), ''); assert.equal(signUpFormError(['email']), ''); assert.equal(signUpFormError('constructor'), ''); assert.equal(signUpFormError(undefined), '')
  assert.deepEqual(Object.keys(SIGN_UP_FORM_ERRORS).sort(), ['email', 'exists', 'failed', 'password', 'rate', 'unavailable'])
})

test('#1116 a cross-site or Origin-less form post is refused and creates nothing (login CSRF stays closed, #1095)', async () => {
  const before = users()
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: '' }]) {
    const fields = { ...FIELDS, email: `x${ip}@fixture-1116.test` }
    const res = await signup.POST(formReq(fields, headers))
    assert.equal(res.status, 303); assert.equal(res.headers.get('location'), '/sign-up?error=failed')
    assert.equal(res.headers.get('set-cookie'), null, 'no session cookie')
  }
  assert.equal(users(), before)
  // a JSON post is unchanged: JSON in, JSON out, and a form-typed body is not accepted as JSON
  const json = await signup.POST(new NextRequest('http://localhost/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': '10.12.0.1' }, body: JSON.stringify({ ...FIELDS, email: 'json@fixture-1116.test' }) }))
  assert.equal(json.status, 200); assert.equal((await json.json()).check_email, true)
  const text = await signup.POST(new NextRequest('http://localhost/api/auth/signup', { method: 'POST', headers: { 'content-type': 'text/plain', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': '10.12.0.2' }, body: 'x' }))
  assert.equal(text.status, 400, 'any other content type is still refused')
})

test('#1116 the same address posted again natively gets the same "check your email" answer (no account enumeration)', async () => {
  const before = users()
  const res = await signup.POST(formReq(FIELDS))
  assert.equal(res.status, 303); assert.equal(res.headers.get('location'), '/sign-up?sent=1')
  assert.equal(users(), before, 'no second account')
  console.log('SIGNUP FORM 1116 ok')
})
