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
import { createPasswordUser, createSession, getSessionUser, hashToken } from '../../lib/auth-db.ts'
import { resolveUser } from '../../lib/auth-google.ts'
import { getDb } from '../../lib/db/client.ts'
import { sendVerification as sendVerificationLink } from '../../lib/email-ownership.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.SYSTEM_MAIL_SMTP_URL = 'smtp://fixture.invalid'; process.env.SYSTEM_MAIL_FROM = 'fixture@example.test'
const { setTransportForTests } = await import('../../lib/system-mail.ts')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
setTransportForTests(async m => { raw.prepare('INSERT INTO system_mail_outbox (id,user_id,to_email,subject,body,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), (raw.prepare('SELECT id FROM users WHERE email = ?').get(m.to) as { id: string } | undefined)?.id ?? 'fixture',m.to,m.subject,m.text,Math.floor(Date.now()/1000)) })
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
  await createPasswordUser({ id: 'P', email: 'pat@example.test', name: 'P', business_name: 'P', password_hash: 'h'.repeat(128), salt: 's'.repeat(32), requireConfirmation: true })
  const g = await resolveUser(await getDb(), { sub: 'g-1', email: 'gee@example.test', name: 'G' })
  assert.ok('user_id' in g)
  const smtp = process.env.SYSTEM_MAIL_SMTP_URL; delete process.env.SYSTEM_MAIL_SMTP_URL
  const unavailable = await resetRequest.POST(req('/api/auth/reset/request', { email: 'pat@example.test' }))
  assert.equal(unavailable.status,503); assert.equal((raw.prepare('SELECT count(*) AS n FROM email_tokens').get() as { n: number }).n,0)
  process.env.SYSTEM_MAIL_SMTP_URL = smtp
  const answers = [await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'pat@example.test' }))),
    await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'gee@example.test' }))),
    await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'nobody@example.test' }))),
    await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'not an email' })))]
  assert.equal(new Set(answers).size, 1, answers.join('\n'))

  const s1 = await createSession('P'), s2 = await createSession('P')
  const token = link('P', 'reset')!
  assert.equal((await reset.POST(req('/api/auth/reset', { token, password: 'short' }))).status, 400)
  // P stays unconfirmed (the reset proves its email): its sessions are checked as rows, not through the app gate
  const revoked = (t: string) => (raw.prepare('SELECT revoked_at AS r FROM sessions WHERE id = ?').get(hashToken(t)) as { r: number | null }).r !== null
  assert.equal(revoked(s1), false, 'a refused reset changes nothing')
  assert.equal(await getSessionUser(s1), null, '#357: an unconfirmed account reaches nothing')
  const ok = await reset.POST(req('/api/auth/reset', { token, password: 'a new password 42' }))
  assert.deepEqual(await ok.json(), { ok: true, redirect: '/sign-in?reset=1' })
  assert.equal(revoked(s1), true); assert.equal(revoked(s2), true)
  assert.equal(await getSessionUser(s1), null, 'confirmed by the reset, but the old sessions stay revoked'); assert.equal(await getSessionUser(s2), null)
  const row = raw.prepare("SELECT password_hash, salt, email_verified_at FROM users WHERE id = 'P'").get() as { password_hash: string; salt: string; email_verified_at: number | null }
  assert.ok(timingSafeEqual(scryptSync('a new password 42', row.salt, 64), Buffer.from(row.password_hash, 'hex')))
  assert.notEqual(row.email_verified_at, null, 'opening the reset link proved the email')
  assert.deepEqual(await (await reset.POST(req('/api/auth/reset', { token, password: 'another password 43' }))).json(), { error: 'invalid_link' })

  // an account made before the confirmation requirement (#357, narrowed on #608) keeps its session unconfirmed, as on
  // main, and verifies its email through the link it asks for from Settings
  await createPasswordUser({ id: 'Q', email: 'quinn@example.test', name: 'Q', business_name: 'Q', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
  const tq = await createSession('Q')
  const status = async () => (await withJar(new Map([['dazl_session', tq]]), () => email.GET())).json()
  assert.deepEqual(await status(), { email: 'quinn@example.test', verified: false, google: false })
  const sent = await withJar(new Map([['dazl_session', tq]]), () => sendVerification.POST(req('/api/auth/email/send-verification', {})))
  assert.deepEqual(await sent.json(), { ok: true, sent: true })
  // an account made under the requirement: its session reaches nothing until the link it was sent is opened
  await createPasswordUser({ id: 'R', email: 'rae@example.test', name: 'R', business_name: 'R', password_hash: 'h'.repeat(128), salt: 's'.repeat(32), requireConfirmation: true })
  const tr = await createSession('R')
  assert.deepEqual(await (await withJar(new Map([['dazl_session', tr]]), () => email.GET())).json(), { error: 'Not signed in' })
  assert.equal((await withJar(new Map([['dazl_session', tr]]), () => sendVerification.POST(req('/api/auth/email/send-verification', {})))).status, 401)
  assert.equal(await sendVerificationLink(await getDb(), 'R'), true)
  assert.equal((await verify.POST(req('/api/auth/verify', { token: link('R', 'verify')! }))).status, 200)
  assert.deepEqual(await (await withJar(new Map([['dazl_session', tr]]), () => email.GET())).json(), { email: 'rae@example.test', verified: true, google: false })
  const v = link('Q', 'verify')!
  assert.equal((await verify.POST(req('/api/auth/verify', { token: v }))).status, 200)
  assert.equal((await verify.POST(req('/api/auth/verify', { token: v }))).status, 410, 'replay')
  assert.deepEqual(await status(), { email: 'quinn@example.test', verified: true, google: false })
  console.log('EMAIL ROUTES ok')
})

test('expired links do nothing at the routes; change email answers the same whether or not the address is taken', async () => {
  await createPasswordUser({ id: 'X', email: 'xan@example.test', name: 'X', business_name: 'X', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
  await createPasswordUser({ id: 'Y', email: 'yam@example.test', name: 'Y', business_name: 'Y', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
  raw.prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'X'").run() // #357: only confirmed accounts have live sessions
  const sx = await createSession('X')
  const expire = (purpose: string) => raw.prepare('UPDATE email_tokens SET expires_at = 1 WHERE user_id = ? AND purpose = ?').run('X', purpose)
  // reset link past its 30 minutes: refused, the password and every session stay as they were
  await resetRequest.POST(req('/api/auth/reset/request', { email: 'xan@example.test' }))
  const rt = link('X', 'reset')!; assert.ok(rt); expire('reset')
  assert.deepEqual(await (await reset.POST(req('/api/auth/reset', { token: rt, password: 'a new password 42' }))).json(), { error: 'invalid_link' })
  assert.ok(await getSessionUser(sx), 'an expired reset link signs nobody out')
  assert.equal((raw.prepare("SELECT password_hash FROM users WHERE id = 'X'").get() as { password_hash: string }).password_hash, 'h'.repeat(128))
  // verification link past its 24 hours: refused, the email stays unverified (an unconfirmed account, Z)
  await createPasswordUser({ id: 'Z', email: 'zed@example.test', name: 'Z', business_name: 'Z', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
  assert.equal(await sendVerificationLink(await getDb(), 'Z'), true)
  const vt = link('Z', 'verify')!; assert.ok(vt); raw.prepare("UPDATE email_tokens SET expires_at = 1 WHERE user_id = 'Z' AND purpose = 'verify'").run()
  assert.equal((await verify.POST(req('/api/auth/verify', { token: vt }))).status, 410)
  assert.equal((raw.prepare("SELECT email_verified_at AS v FROM users WHERE id = 'Z'").get() as { v: number | null }).v, null)
  // change email to Y's address and to a free one: the same answer (only the typed address differs), nothing sent to Y
  const change = async (to: string) => (await text(await withJar(new Map([['dazl_session', sx]]), () => email.POST(req('/api/auth/email', { email: to }))))).replaceAll(to, '<email>')
  const taken = await change('yam@example.test'), free = await change('free-addr@example.test')
  assert.equal(taken, free)
  assert.match(taken, /^200 /)
  assert.equal((raw.prepare("SELECT count(*) AS n FROM system_mail_outbox WHERE to_email = 'yam@example.test'").get() as { n: number }).n, 0)
  console.log('EMAIL ROUTES expired+change ok')
})
