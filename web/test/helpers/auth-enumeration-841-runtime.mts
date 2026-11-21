// #841: forgot password (POST /api/auth/reset/request) and verification resend (POST /api/auth/email/send-verification),
// through the real route handlers, the real session lookup and the real rate-limit store, on SQLite and (when
// DAZL_TEST_PG_URL is set) on a Postgres-only fixture. No mocks around the path: only the mail transport is captured
// (and can be held open, as a slow mail server would be) and any outbound fetch fails the run.
//   1. a known and an unknown email get the same answer (status, body, headers) and the same timing class: the answer
//      does not wait on the account lookup or the mail send, so a slow mail server cannot tell them apart;
//   2. the Nth request inside the window gets 429 with a generic message, per email (the same 429 for a known and an
//      unknown email) and per IP; verification resend likewise per IP and per email.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { settleAfter } from './next-server-after-shim.mjs'
import { setScanDb, trapScanDb } from './tenant-route-db.ts'
import { withJar } from './pg-session-headers.ts'
import { setDb, pgDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { createPasswordUser, createSession } from '../../lib/auth-db.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
Object.assign(process.env, { SYSTEM_MAIL_SMTP_URL: 'smtp://fixture.invalid', SYSTEM_MAIL_FROM: 'fixture@example.test' })

// The mail transport, captured. While `held` is set every send waits on it, as on a slow mail server.
const mails: { to: string; subject: string }[] = []
let held: Promise<void> | null = null
const { setTransportForTests } = await import('../../lib/system-mail.ts')
setTransportForTests(async m => { if (held) await held; mails.push({ to: m.to, subject: m.subject }) })

const resetRequest = await import('../../app/api/auth/reset/request/route.ts')
const sendVerification = await import('../../app/api/auth/email/send-verification/route.ts')

let n = 0
const freshIp = () => `10.84.${Math.floor(++n / 250)}.${n % 250}`
const post = (path: string, body: unknown, ip = freshIp()) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': ip }, body: JSON.stringify(body) })
// everything a caller can read from an answer, except Date (wall clock)
const answer = async (r: Response) => ({ status: r.status, retryAfter: r.headers.get('retry-after'), type: r.headers.get('content-type'), body: await r.text() })
const TIMED_OUT = Symbol('timed out')
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<typeof TIMED_OUT>(r => setTimeout(() => r(TIMED_OUT), ms))])
const forgot = (email: string, ip?: string) => resetRequest.POST(post('/api/auth/reset/request', { email }, ip))
const TOO_MANY = { status: 429, body: JSON.stringify({ error: 'Too many requests. Try again later.' }) }

async function scenario(db: Db, engine: string) {
  mails.length = 0
  await createPasswordUser({ id: 'known_841', email: 'known@example.test', name: 'K', business_name: 'K Co', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) }, db)

  // 1. same answer, same timing class: the mail server is held open, so an answer that waits on the send never comes
  let release!: () => void
  held = new Promise<void>(r => { release = r })
  try {
    const known = await within(forgot('known@example.test'), 3000)
    const unknown = await within(forgot('nobody-841@example.test'), 3000)
    assert.notEqual(known, TIMED_OUT, `[${engine}] a known email's answer waited on the mail send (an unknown one does not): the timing tells them apart`)
    assert.notEqual(unknown, TIMED_OUT, `[${engine}] an unknown email's answer timed out`)
    assert.deepEqual(await answer(known as Response), await answer(unknown as Response), `[${engine}] known and unknown email answer differently`)
    assert.equal((known as Response).status, 200)
  } finally { release(); held = null }
  await settleAfter()
  // the deferred work still happened: the known account got its link, the unknown address nothing
  assert.deepEqual(mails.map(m => m.to), ['known@example.test'], `[${engine}] reset mail`)

  // 2a. per email: 3 an hour, each from its own IP; the 4th gets the generic 429, the same for known and unknown
  for (const email of ['known@example.test', 'nobody-841@example.test']) {
    for (let i = 2; i <= 3; i++) assert.equal((await forgot(email)).status, 200, `[${engine}] ${email} request ${i}`)
  }
  const knownOver = await answer(await forgot('known@example.test'))
  const unknownOver = await answer(await forgot('nobody-841@example.test'))
  assert.deepEqual({ status: knownOver.status, body: knownOver.body }, TOO_MANY, `[${engine}] the 4th request for a known email inside the window`)
  assert.deepEqual({ status: unknownOver.status, body: unknownOver.body }, TOO_MANY, `[${engine}] the 4th request for an unknown email inside the window`)
  assert.equal(knownOver.type, unknownOver.type)
  assert.ok(Number(knownOver.retryAfter) > 0 && Number(unknownOver.retryAfter) > 0, `[${engine}] Retry-After on both`)
  // the email limit counts the address whatever the case it is typed in
  assert.deepEqual({ status: (await forgot('KNOWN@Example.Test')).status }, { status: 429 }, `[${engine}] the same address in other case`)

  // 2b. per IP: 10 an hour from one IP, each for a different address; the 11th gets the same generic 429
  const ip = freshIp()
  for (let i = 1; i <= 10; i++) assert.equal((await forgot(`ip-${i}-841@example.test`, ip)).status, 200, `[${engine}] IP request ${i}`)
  const ipOver = await answer(await forgot('ip-11-841@example.test', ip))
  assert.deepEqual({ status: ipOver.status, body: ipOver.body }, TOO_MANY, `[${engine}] the 11th request from one IP inside the window`)
  await settleAfter()

  // 3. verification resend: 3 an hour per account and per email, 10 an hour per IP, every one the generic 429
  const resend = async (session: string, ip?: string) => answer(await withJar(new Map([['dazl_session', session]]), () => sendVerification.POST(post('/api/auth/email/send-verification', {}, ip))))
  const accounts = ['v1', 'v2', 'v3', 'v4']
  for (const id of accounts) await createPasswordUser({ id: `${id}_841`, email: `${id}-841@example.test`, name: id, business_name: id, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) }, db)
  const sessions = await Promise.all(accounts.map(id => createSession(`${id}_841`, db)))
  // per IP: three accounts behind one IP send their 3 each (9), a fourth account's 2nd send is the 11th from that IP
  const shared = freshIp()
  for (const s of sessions.slice(0, 3)) for (let i = 1; i <= 3; i++) assert.deepEqual(await resend(s, shared).then(a => [a.status, a.body]), [200, JSON.stringify({ ok: true, sent: true })], `[${engine}] resend ${i}`)
  assert.equal((await resend(sessions[3], shared)).status, 200, `[${engine}] 10th resend from one IP`)
  const resendIpOver = await resend(sessions[3], shared)
  assert.deepEqual({ status: resendIpOver.status, body: resendIpOver.body }, TOO_MANY, `[${engine}] the 11th resend from one IP inside the window`)
  // per account: v1's 4th send from a fresh IP
  const resendAcctOver = await resend(sessions[0])
  assert.deepEqual({ status: resendAcctOver.status, body: resendAcctOver.body }, TOO_MANY, `[${engine}] the 4th resend for one account inside the window`)
  // per email: v1's address moves to a fresh account (v1 takes another): that account's 1st send to the address is its 4th
  await db.run("UPDATE users SET email = 'v1-moved-841@example.test' WHERE id = 'v1_841'")
  await createPasswordUser({ id: 'v5_841', email: 'v1-841@example.test', name: 'v5', business_name: 'v5', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) }, db)
  const resendEmailOver = await resend(await createSession('v5_841', db))
  assert.deepEqual({ status: resendEmailOver.status, body: resendEmailOver.body }, TOO_MANY, `[${engine}] the 4th resend to one email inside the window`)
  console.log(`AUTH ENUMERATION 841 ok ${engine}`)
}

test('#841 forgot password and verification resend: same answer known vs unknown; Nth request inside the window gets 429 (SQLite)', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  setScanDb(raw)
  const { getDb } = await import('../../lib/db/client.ts')
  await scenario(await getDb(), 'sqlite')
})

test('#841 the same on Postgres', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    await runPgMigrations(db.pool)
    trapScanDb(); setDb(db)
    await scenario(db, 'pg')
  } finally { setDb(null); await db.close(); await s.drop() }
})
