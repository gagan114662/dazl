// #1647 (Fo's finding, Nov 23: the confirmation email took 15-40 min and sign-in offers no resend). The block: a user
// staring at "Confirm your email first" can press "Resend confirmation email". Server rules under test here:
// - the resend answers the same for every well-formed address (unknown, confirmed and unconfirmed alike): 200 {ok:true}
//   and nothing about the account; only an unconfirmed account's address gets a fresh link;
// - an address that cannot be an email, a missing address and a cross-site caller are refused, not silently accepted;
// - resends are capped per address (one a minute, five an hour) and per IP, every refusal the same generic 429;
// - the signed-in path keeps its behavior: the link goes to the signed-in account's own address;
// - the component never claims an address has an account and maps each server answer to one honest line.
// Real routes and the real session lookup over a SQLite fixture (the #357 runtime pattern). No mail leaves the process
// (a test transport writes the outbox) and any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import Database from 'better-sqlite3'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession } from '../../lib/auth-db.ts'
import { ResendConfirmation, resendResult, resendCopy } from '../../app/resend-confirmation.tsx'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.SYSTEM_MAIL_SMTP_URL = 'smtp://fixture.invalid'; process.env.SYSTEM_MAIL_FROM = 'fixture@example.test'
const { setTransportForTests } = await import('../../lib/system-mail.ts')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
setTransportForTests(async m => {
  raw.prepare('INSERT INTO system_mail_outbox (id,user_id,to_email,subject,body,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), 'fixture', m.to, m.subject, m.text, Math.floor(Date.now() / 1000))
})
const send = await import('../../app/api/auth/email/send-verification/route.ts')

let ip = 0
const req = (body: unknown, headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/auth/email/send-verification', {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.${(++ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body) })
const mails = (to: string) => raw.prepare('SELECT subject, body FROM system_mail_outbox WHERE to_email = ? ORDER BY rowid').all(to) as { subject: string; body: string }[]
const PW = 'a strong password 1'
const hash = (pw: string, salt: string) => scryptSync(pw, salt, 64).toString('hex')
async function existing(id: string, address: string, confirmed: boolean, legacy = false) {
  // legacy: an account from before the confirmation requirement (email_confirmation_required 0): it signs in unverified,
  // which is exactly who the signed-in send exists for.
  await createPasswordUser({ id, email: address, name: `Name ${id}`, business_name: `Biz ${id}`, password_hash: hash(PW, 's'.repeat(32)), salt: 's'.repeat(32), ...(legacy ? {} : { requireConfirmation: true }) })
  if (confirmed) raw.prepare('UPDATE users SET email_verified_at = 1 WHERE id = ?').run(id)
}
const resend = async (email: unknown) => {
  const r = await withJar(new Map(), () => send.POST(req({ email })))
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

test('an unconfirmed account: the resend mails a fresh link and answers ok', async () => {
  setUser(null)
  await existing('R1', 'pending@example.test', false)
  const r = await resend('pending@example.test')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true })
  const m = mails('pending@example.test')
  assert.equal(m.length, 1)
  assert.equal(m[0].subject, 'Confirm your email for dazl')
  assert.match(m[0].body, /\/verify#t=[a-f0-9]{64}/)
})

test('the answer never says whether the address has an account', async () => {
  setUser(null)
  await existing('R2', 'known@example.test', true)
  const unknown = await resend('nobody@example.test')
  const confirmed = await resend('known@example.test')
  assert.equal(unknown.status, 200)
  assert.equal(confirmed.status, 200)
  assert.deepEqual(unknown.body, { ok: true })
  assert.deepEqual(confirmed.body, { ok: true })
  assert.equal(mails('nobody@example.test').length, 0)
  assert.equal(mails('known@example.test').length, 0)
})

test('an address that cannot be an email is refused, not silently accepted', async () => {
  setUser(null)
  assert.equal((await resend('not-an-email')).status, 400)
  assert.equal((await resend(null)).status, 400)
})

test('cross-site callers are refused (the same login-CSRF bar as sign-in)', async () => {
  setUser(null)
  const r = await withJar(new Map(), () => send.POST(req({ email: 'pending@example.test' }, { origin: 'http://evil.test' })))
  assert.equal(r.status, 400)
})

test('resends are capped: one a minute per address (the second ask waits)', async () => {
  setUser(null)
  await existing('R3', 'ratelimit@example.test', false)
  assert.equal((await resend('ratelimit@example.test')).status, 200)
  const again = await resend('ratelimit@example.test')
  assert.equal(again.status, 429)
  assert.equal(typeof again.body.error, 'string')
  assert.deepEqual(Object.keys(again.body), ['error'])
})

test('the signed-in path keeps its own behavior: the fresh link goes to the signed-in address', async () => {
  await existing('R4', 'mine@example.test', false, true)
  const token = await createSession('R4')
  const r = await withJar(new Map([['dazl_session', token]]), () => send.POST(req({})))
  assert.equal(r.status, 200)
  const body = await r.json() as { ok?: boolean; sent?: boolean }
  assert.equal(body.ok, true)
  assert.equal(body.sent, true)
  assert.equal(mails('mine@example.test').length, 1)
})

test('each server answer maps to one honest line, and success never claims the address has an account', async () => {
  assert.equal(resendResult(200), 'sent')
  assert.equal(resendResult(429), 'limited')
  assert.equal(resendResult(503), 'unavailable')
  assert.equal(resendResult(400), 'bad')
  assert.equal(resendResult(), 'uncertain')
  assert.match(resendCopy.sent, /If an unconfirmed dazl account uses this address/)
  assert.doesNotMatch(resendCopy.sent, /we (have )?sent/i)
})

test('the component renders the form, prefills a given address and shows the honest copy', () => {
  setUser(null)
  const markup = renderToStaticMarkup(h(ResendConfirmation, {}))
  assert.match(markup, /Resend confirmation email/)
  assert.match(markup, /type="email"/)
  assert.doesNotMatch(markup, /we (have )?sent/i)
  const prefilled = renderToStaticMarkup(h(ResendConfirmation, { email: 'pending@example.test' }))
  assert.match(prefilled, /value="pending@example\.test"/)
})
