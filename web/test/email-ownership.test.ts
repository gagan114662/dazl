// Email ownership and account recovery (lib/email-ownership.ts, lib/system-mail.ts), on both engines. No mail leaves
// the process: without SMTP configured, dazl's own mail goes to system_mail_outbox, which these tests read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPasswordUser, createSession, getSessionUser } from '../lib/auth-db.ts'
import { resolveUser } from '../lib/auth-google.ts'
import { RESET_TTL_S, VERIFIED_BACKFILL_SQL, VERIFY_TTL_S, emailStatus, isEmailVerified, requestReset, resetPassword, sendVerification, verifyEmail } from '../lib/email-ownership.ts'
import { reapOutbox, sendSystemMail, setTransportForTests } from '../lib/system-mail.ts'
import type { Db } from '../lib/db/client.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = Math.floor(Date.now() / 1000)
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: id, password_hash: 'old-hash', salt: 'old-salt' })
const outbox = (db: Db, userId: string) => db.all<{ to_email: string; subject: string; body: string }>('SELECT to_email, subject, body FROM system_mail_outbox WHERE user_id = ? ORDER BY created_at, id', [userId])
const tokenIn = (body: string, path: string) => new RegExp(`/${path}#t=([a-f0-9]{64})`).exec(body)?.[1]
const sha = (t: string) => createHash('sha256').update(t).digest('hex')
// the links mailed to an account, in the order they were issued (by their tokens' issue time)
async function links(db: Db, userId: string, path: string): Promise<string[]> {
  const issued = new Map((await db.all<{ token_hash: string; created_at: number }>('SELECT token_hash, created_at FROM email_tokens WHERE user_id = ?', [userId])).map(r => [r.token_hash, Number(r.created_at)]))
  return (await outbox(db, userId)).map(m => tokenIn(m.body, path)!).sort((a, b) => issued.get(sha(a))! - issued.get(sha(b))!)
}

bothEngines('verification: the link verifies once, only for the email it was sent to; only the token hash is stored', async ({ db }) => {
  await createPasswordUser(user('A'), db)
  assert.equal(await isEmailVerified(db, 'A'), false)
  assert.equal(await sendVerification(db, 'A', NOW), true)
  const [mail] = await outbox(db, 'A')
  assert.equal(mail.to_email, 'a@example.test')
  const token = tokenIn(mail.body, 'verify')!
  const stored = await db.all<{ token_hash: string }>('SELECT token_hash FROM email_tokens WHERE user_id = ?', ['A'])
  assert.deepEqual(stored.map(r => r.token_hash), [createHash('sha256').update(token).digest('hex')])
  assert.equal(await verifyEmail(db, 'f'.repeat(64)), false)
  assert.equal(await verifyEmail(db, token), true)
  assert.deepEqual(await emailStatus(db, 'A'), { email: 'a@example.test', verified: true, google: false })
  assert.equal(await verifyEmail(db, token), false, 'replay')
  assert.equal(await sendVerification(db, 'A'), false, 'already verified: nothing sent')
})

bothEngines('verification: expired links, superseded links and links for an old email do nothing', async ({ db }) => {
  await createPasswordUser(user('A'), db)
  await sendVerification(db, 'A', NOW - VERIFY_TTL_S - 1)
  const expired = tokenIn((await outbox(db, 'A'))[0].body, 'verify')!
  assert.equal(await verifyEmail(db, expired), false)
  await sendVerification(db, 'A', NOW - 1)
  await sendVerification(db, 'A', NOW)
  const [, first, second] = await links(db, 'A', 'verify')
  assert.equal(await verifyEmail(db, first), false, 'superseded by the newer link')
  await db.run("UPDATE users SET email = 'new@example.test' WHERE id = 'A'")
  assert.equal(await verifyEmail(db, second), false, 'sent to the old address')
  assert.equal(await isEmailVerified(db, 'A'), false)
})

bothEngines('forgot password: unknown email sends nothing, a Google account gets no reset link, a password account does', async ({ db }) => {
  await createPasswordUser(user('A'), db)
  const g = await resolveUser(db, { sub: 'g-1', email: 'g@example.test', name: 'G' })
  assert.ok('user_id' in g)
  await requestReset(db, 'nobody@example.test')
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM system_mail_outbox'))!.n), 0)
  await requestReset(db, 'g@example.test')
  const [gm] = await outbox(db, g.user_id)
  assert.equal(tokenIn(gm.body, 'reset'), undefined)
  assert.match(gm.body, /Continue with Google/)
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM email_tokens WHERE purpose = 'reset'"))!.n), 0)
  await requestReset(db, 'a@example.test')
  assert.ok(tokenIn((await outbox(db, 'A'))[0].body, 'reset'))
})

bothEngines('reset: sets the password, proves the email, signs out everywhere, works once; older and expired links fail', async ({ db }) => {
  await createPasswordUser(user('A'), db); await createPasswordUser(user('B'), db)
  const s1 = await createSession('A', db), s2 = await createSession('A', db), sb = await createSession('B', db)
  await requestReset(db, 'a@example.test', NOW - RESET_TTL_S - 1)
  await requestReset(db, 'a@example.test', NOW - 1)
  await requestReset(db, 'a@example.test', NOW)
  const [expired, older, newest] = await links(db, 'A', 'reset')
  const next = { password_hash: 'new-hash', salt: 'new-salt' }
  assert.equal(await resetPassword(db, expired, next), false)
  assert.equal(await resetPassword(db, older, next), false, 'superseded')
  assert.equal((await db.get<{ h: string }>("SELECT password_hash AS h FROM users WHERE id = 'A'"))!.h, 'old-hash')
  assert.ok(await getSessionUser(s1, db))
  assert.equal(await resetPassword(db, newest, next, NOW), true)
  assert.deepEqual(await db.get("SELECT password_hash, salt FROM users WHERE id = 'A'"), next)
  assert.equal(await isEmailVerified(db, 'A'), true)
  assert.equal(await getSessionUser(s1, db), null); assert.equal(await getSessionUser(s2, db), null)
  assert.deepEqual((await db.all<{ r: string }>("SELECT DISTINCT revoke_reason AS r FROM sessions WHERE user_id = 'A'")).map(x => x.r), ['recovery'])
  assert.ok(await getSessionUser(sb, db), "another account's session is untouched")
  assert.equal(await resetPassword(db, newest, { password_hash: 'x', salt: 'y' }), false, 'replay')
  assert.equal(await resetPassword(db, 'not-a-token', next), false)
})

bothEngines('Google accounts are verified: new ones at sign-up, existing ones by the backfill', async ({ db }) => {
  const g = await resolveUser(db, { sub: 'g-2', email: 'g2@example.test', name: 'G' })
  assert.ok('user_id' in g && await isEmailVerified(db, g.user_id))
  await createPasswordUser(user('P'), db)
  await db.run("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES ('OLDG', 'oldg@example.test', 'h', 's', 77)")
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'g-old', 'OLDG')")
  await db.run(VERIFIED_BACKFILL_SQL)
  assert.equal((await db.get<{ v: number }>("SELECT email_verified_at AS v FROM users WHERE id = 'OLDG'"))!.v, 77)
  assert.equal(await isEmailVerified(db, 'P'), false, 'a password account is not verified by the backfill')
})

bothEngines('system mail: SMTP when configured (stubbed here), the outbox otherwise; the outbox is reaped after a day', async ({ db }) => {
  const sent: string[] = []
  setTransportForTests(async m => { sent.push(`${m.from}->${m.to}:${m.subject}`) })
  try {
    const env = { SYSTEM_MAIL_SMTP_URL: 'smtp://stub.invalid', SYSTEM_MAIL_FROM: 'dazl <no-reply@dazl.test>' }
    assert.equal(await sendSystemMail(db, { userId: 'A', to: 'a@example.test', subject: 'Hi', text: 'x' }, env), 'sent')
    assert.deepEqual(sent, ['dazl <no-reply@dazl.test>->a@example.test:Hi'])
    assert.equal(await sendSystemMail(db, { userId: 'A', to: 'a@example.test', subject: 'Hi', text: 'x' }, { SYSTEM_MAIL_SMTP_URL: 'smtp://stub.invalid' }), 'outbox', 'no sender: not sent')
  } finally { setTransportForTests(null) }
  assert.equal(await reapOutbox(db, { now: NOW }), 0)
  assert.equal(await reapOutbox(db, { now: NOW + 2 * 24 * 60 * 60 }), 1)
})

test('the PG migration backfills Google accounts with exactly the SQL the SQLite startup runs', async () => {
  const { readFileSync } = await import('node:fs')
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const mig = norm(readFileSync(new URL('../lib/db/migrations/pg/0018_email_ownership.sql', import.meta.url), 'utf8'))
  assert.ok(mig.includes(norm(VERIFIED_BACKFILL_SQL) + ';'))
})
