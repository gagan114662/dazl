// #841: the auth email routes past their rate limits, through the real handlers (workspace-session-loader.mjs).
// Forgot password: one IP gets 429 + Retry-After after 10 an hour; one email past 3 an hour gets the same generic
// answer as everyone else and no more mail. Verify: 429 after 20 an hour per IP. Send verification: 429 after 3 an
// hour per account. Change email: 429 after 5 an hour per account. No mail leaves the process; any fetch fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession } from '../../lib/auth-db.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.SYSTEM_MAIL_SMTP_URL = 'smtp://fixture.invalid'; process.env.SYSTEM_MAIL_FROM = 'fixture@example.test'
const { setTransportForTests } = await import('../../lib/system-mail.ts')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const sent: string[] = []
setTransportForTests(async m => { sent.push(m.to) })
const resetRequest = await import('../../app/api/auth/reset/request/route.ts')
const verify = await import('../../app/api/auth/verify/route.ts')
const sendVerification = await import('../../app/api/auth/email/send-verification/route.ts')
const email = await import('../../app/api/auth/email/route.ts')

const req = (path: string, body: unknown, ip: string) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': ip }, body: JSON.stringify(body) })
const text = async (r: Response) => `${r.status} ${await r.text()}`
const user = async (id: string, addr: string) => {
  await createPasswordUser({ id, email: addr, name: id, business_name: id, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
  raw.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').run(id)
  return new Map([['dazl_session', await createSession(id)]])
}

test('forgot password: 429 per IP after 10; past 3 per email the answer stays the same generic one and no mail goes out', async () => {
  await createPasswordUser({ id: 'A', email: 'ann@example.test', name: 'A', business_name: 'A', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
  // per email: 5 asks for ann from 5 IPs, all byte-identical to an unknown email's answer; only 3 links sent
  const generic = await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'nobody@example.test' }, '10.2.0.1')))
  assert.match(generic, /^200 /)
  const ann: string[] = []
  for (let i = 0; i < 5; i++) ann.push(await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'ann@example.test' }, `10.2.1.${i}`))))
  assert.deepEqual(new Set(ann), new Set([generic]), ann.join('\n'))
  assert.equal(sent.filter(t => t === 'ann@example.test').length, 3, 'the per-email cap stops mail silently')
  // per IP: 10 answers, then 429 with Retry-After
  const ip = '10.2.2.1'
  for (let i = 0; i < 10; i++) assert.equal(await text(await resetRequest.POST(req('/api/auth/reset/request', { email: `u${i}@example.test` }, ip))), generic)
  const over = await resetRequest.POST(req('/api/auth/reset/request', { email: 'u99@example.test' }, ip))
  assert.equal(over.status, 429)
  assert.ok(Number(over.headers.get('retry-after')) > 0)
  // a known and an unknown email get the same 429 from that IP: it reveals nothing either
  assert.equal(await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'ann@example.test' }, ip))),
    await text(await resetRequest.POST(req('/api/auth/reset/request', { email: 'nobody2@example.test' }, ip))))
  console.log('RATE reset ok')
})

test('verify: 429 per IP after 20 tries', async () => {
  const ip = '10.3.0.1'
  for (let i = 0; i < 20; i++) assert.equal((await verify.POST(req('/api/auth/verify', { token: 'f'.repeat(64) }, ip))).status, 410)
  assert.equal((await verify.POST(req('/api/auth/verify', { token: 'f'.repeat(64) }, ip))).status, 429)
  assert.equal((await verify.POST(req('/api/auth/verify', { token: 'f'.repeat(64) }, '10.3.0.2'))).status, 410, 'another IP is unaffected')
  console.log('RATE verify ok')
})

test('send verification: 429 per account after 3; change email: 429 per account after 5', async () => {
  const jar = await user('S', 'sam@example.test')
  for (let i = 0; i < 3; i++) assert.equal((await withJar(jar, () => sendVerification.POST(req('/api/auth/email/send-verification', {}, `10.4.0.${i}`)))).status, 200)
  assert.equal((await withJar(jar, () => sendVerification.POST(req('/api/auth/email/send-verification', {}, '10.4.1.1')))).status, 429, 'a new IP does not reset the account cap')
  const other = await user('T', 'tia@example.test')
  assert.equal((await withJar(other, () => sendVerification.POST(req('/api/auth/email/send-verification', {}, '10.4.2.1')))).status, 200, 'another account is unaffected')

  raw.prepare("UPDATE users SET email_verified_at = 1 WHERE id IN ('S','T')").run()
  for (let i = 0; i < 5; i++) assert.equal((await withJar(jar, () => email.POST(req('/api/auth/email', { email: `new${i}@example.test` }, `10.5.0.${i}`)))).status, 200)
  assert.equal((await withJar(jar, () => email.POST(req('/api/auth/email', { email: 'new9@example.test' }, '10.5.1.1')))).status, 429)
  assert.equal((await withJar(other, () => email.POST(req('/api/auth/email', { email: 'tnew@example.test' }, '10.5.2.1')))).status, 200, 'another account is unaffected')
  console.log('RATE send+change ok')
})
