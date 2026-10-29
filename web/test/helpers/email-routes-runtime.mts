// Email verification and password reset through the real routes (workspace-session-loader.mjs). The forgot-password
// answer is byte-identical for a password account, a Google account, an unknown and a malformed email; a reset link
// from the outbox sets the password and signs the account out everywhere; links fail when replayed. No mail leaves
// the process (no SMTP configured: the outbox), and any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync, timingSafeEqual } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, getSessionUser } from '../../lib/auth-db.ts'
import { resolveUser } from '../../lib/auth-google.ts'
import { getDb } from '../../lib/db/client.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
delete process.env.SYSTEM_MAIL_SMTP_URL; delete process.env.SYSTEM_MAIL_FROM

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const resetRequest = await import('../../app/api/auth/reset/request/route.ts')
const reset = await import('../../app/api/auth/reset/route.ts')
const verify = await import('../../app/api/auth/verify/route.ts')
const sendVerification = await import('../../app/api/auth/email/send-verification/route.ts')
const email = await import('../../app/api/auth/email/route.ts')

let ip = 0
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.1.0.${++ip}` }, body: JSON.stringify(body) })
const text = async (r: Response) => `${r.status} ${await r.text()}`
const link = (userId: string, path: string) => {
  const rows = raw.prepare('SELECT body FROM system_mail_outbox WHERE user_id = ? ORDER BY rowid DESC').all(userId) as { body: string }[]
  return rows.map(r => new RegExp(`/${path}#t=([a-f0-9]{64})`).exec(r.body)?.[1]).find(Boolean)
}

test('forgot password reveals nothing; a reset link works once and signs out everywhere; verification works once', async () => {
  await createPasswordUser({ id: 'P', email: 'pat@example.test', name: 'P', business_name: 'P', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
  const g = await resolveUser(await getDb(), { sub: 'g-1', email: 'gee@example.test', name: 'G' })
  assert.ok('user_id' in g)
  const answers = [await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'pat@example.test' }))),
    await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'gee@example.test' }))),
    await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'nobody@example.test' }))),
    await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'not an email' })))]
  assert.equal(new Set(answers).size, 1, answers.join('\n'))

  const s1 = await createSession('P'), s2 = await createSession('P')
  const token = link('P', 'reset')!
  assert.equal((await reset.POST(req('/api/auth/reset', { token, password: 'short' }))).status, 400)
  assert.ok(await getSessionUser(s1), 'a refused reset changes nothing')
  const ok = await reset.POST(req('/api/auth/reset', { token, password: 'a new password 42' }))
  assert.deepEqual(await ok.json(), { ok: true, redirect: '/sign-in?reset=1' })
  assert.equal(await getSessionUser(s1), null); assert.equal(await getSessionUser(s2), null)
  const row = raw.prepare("SELECT password_hash, salt, email_verified_at FROM users WHERE id = 'P'").get() as { password_hash: string; salt: string; email_verified_at: number | null }
  assert.ok(timingSafeEqual(scryptSync('a new password 42', row.salt, 64), Buffer.from(row.password_hash, 'hex')))
  assert.notEqual(row.email_verified_at, null, 'opening the reset link proved the email')
  assert.deepEqual(await (await reset.POST(req('/api/auth/reset', { token, password: 'another password 43' }))).json(), { error: 'invalid_link' })

  // a new password account verifies its email through the link it is sent
  await createPasswordUser({ id: 'Q', email: 'quinn@example.test', name: 'Q', business_name: 'Q', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
  const tq = await createSession('Q')
  const status = async () => (await withJar(new Map([['dazl_session', tq]]), () => email.GET())).json()
  assert.deepEqual(await status(), { email: 'quinn@example.test', verified: false, google: false })
  const sent = await withJar(new Map([['dazl_session', tq]]), () => sendVerification.POST(req('/api/auth/email/send-verification', {})))
  assert.deepEqual(await sent.json(), { ok: true, sent: true })
  const v = link('Q', 'verify')!
  assert.equal((await verify.POST(req('/api/auth/verify', { token: v }))).status, 200)
  assert.equal((await verify.POST(req('/api/auth/verify', { token: v }))).status, 410, 'replay')
  assert.deepEqual(await status(), { email: 'quinn@example.test', verified: true, google: false })
  console.log('EMAIL ROUTES ok')
})
