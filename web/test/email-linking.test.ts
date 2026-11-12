// #357 increment 2: changing the account email, and linking a Google identity to an existing account after fresh
// proof, never by email alone. Two (and three) accounts, both engines; mail goes to the outbox only.
import assert from 'node:assert/strict'
import { createPasswordUser } from '../lib/auth-db.ts'
import { linkGoogle, resolveUser } from '../lib/auth-google.ts'
import { emailStatus, requestEmailChange, verifyEmail } from '../lib/email-ownership.ts'
import type { Db } from '../lib/db/client.ts'
import { bothEngines } from './helpers/engines.ts'

const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: id, password_hash: 'h', salt: 's' })
const verified = (db: Db, id: string) => db.run('UPDATE users SET email_verified_at = 1 WHERE id = ?', [id])
const mails = (db: Db, to: string) => db.all<{ body: string }>('SELECT body FROM system_mail_outbox WHERE to_email = ?', [to])
const link = (body: string) => /\/verify#t=([a-f0-9]{64})/.exec(body)?.[1]
const G = (email: string, sub = `g-${email}`) => ({ sub, email, name: 'G' })

bothEngines("Google linking: only the account with the identity's email links it (an unconfirmed one only through its own fresh session, #1095); never another account, never by sign-in alone", async ({ db }) => {
  await createPasswordUser(user('A'), db); await createPasswordUser(user('B'), db); await createPasswordUser(user('C'), db)
  await verified(db, 'A'); await verified(db, 'B')
  const ga = G('a@example.test')
  // Google sign-in with A's email does not reach A's account until A links it
  assert.deepEqual(await resolveUser(db, ga), { error: 'email_exists' })
  assert.equal(await linkGoogle(db, 'B', ga), 'mismatch', "B cannot take a Google identity carrying A's email")
  // #1095: an unconfirmed account with the identity's own (Google-verified) email links and is confirmed by it; see
  // the #1095 test below for the cases that must leave it unconfirmed
  assert.equal(await linkGoogle(db, 'C', G('c@example.test')), 'unverified', 'without a session the link never confirms the address')
  const { createSession } = await import('../lib/auth-db.ts')
  assert.equal(await linkGoogle(db, 'C', G('c@example.test'), await createSession('C', db)), 'linked', 'Google proves the same address the confirmation link would')
  assert.equal(await linkGoogle(db, 'A', ga), 'linked')
  assert.deepEqual(await resolveUser(db, ga), { user_id: 'A', created: false })
  assert.equal(await linkGoogle(db, 'A', ga), 'already')
  assert.equal(await linkGoogle(db, 'B', ga), 'taken')
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM oauth_identities'))!.n), 2)
  assert.deepEqual(await emailStatus(db, 'A'), { email: 'a@example.test', verified: true, google: true })
})

bothEngines('change email: a link to the new address and a notice to the old; it changes only when opened, and only if still free', async ({ db }) => {
  await createPasswordUser(user('A'), db); await createPasswordUser(user('B'), db)
  await requestEmailChange(db, 'A', 'new@example.test')
  assert.equal((await mails(db, 'a@example.test')).length, 1, 'notice to the current address')
  const token = link((await mails(db, 'new@example.test'))[0].body)!
  assert.equal((await emailStatus(db, 'A'))!.email, 'a@example.test', 'nothing changes before the link is opened')
  assert.equal(await verifyEmail(db, token), true)
  assert.deepEqual(await emailStatus(db, 'A'), { email: 'new@example.test', verified: true, google: false })
  assert.equal(await verifyEmail(db, token), false, 'replay')

  // an address another account has: no link is sent to it (the caller's answer is the same)
  await requestEmailChange(db, 'A', 'b@example.test')
  assert.equal((await mails(db, 'b@example.test')).length, 0)
  // another account takes the address between the request and the click: the change is refused, nothing changes
  await requestEmailChange(db, 'B', 'race@example.test')
  const raced = link((await mails(db, 'race@example.test'))[0].body)!
  await createPasswordUser({ ...user('R'), email: 'race@example.test' }, db)
  assert.equal(await verifyEmail(db, raced), false)
  assert.equal((await emailStatus(db, 'B'))!.email, 'b@example.test')
})

bothEngines('Google linking cannot commit through a session revoked by password recovery', async ({db})=>{
 const {createSession}=await import('../lib/auth-db.ts')
 const {requestReset,resetPassword}=await import('../lib/email-ownership.ts')
 await createPasswordUser(user('late-link'),db);await verified(db,'late-link')
 const session=await createSession('late-link',db)
 await requestReset(db,'late-link@example.test')
 const reset=/\/reset#t=([a-f0-9]{64})/.exec((await mails(db,'late-link@example.test'))[0].body)![1]
 assert.equal(await resetPassword(db,reset,{password_hash:'replacement',salt:'new'}),true)
 assert.equal(await linkGoogle(db,'late-link',G('late-link@example.test'),session),'signed_out')
 assert.equal(Number((await db.get<{n:number}>('SELECT count(*) AS n FROM oauth_identities'))!.n),0)
 const fresh=await createSession('late-link',db)
 await db.run('UPDATE sessions SET authed_at=1 WHERE user_id=?',['late-link'])
 assert.equal(await linkGoogle(db,'late-link',G('late-link@example.test'),fresh),'reauth_required')
 await db.run('UPDATE sessions SET authed_at=? WHERE user_id=?',[Math.floor(Date.now()/1000),'late-link'])
 assert.equal(await linkGoogle(db,'late-link',G('late-link@example.test'),fresh),'linked')
})

const verifiedAt = async (db: Db, id: string) => (await db.get<{ v: number | null }>('SELECT email_verified_at AS v FROM users WHERE id = ?', [id]))!.v
const identities = async (db: Db, id: string) => Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM oauth_identities WHERE user_id = ?', [id]))!.n)

bothEngines('#1095 verify and link in one step: an unconfirmed password account linking a Google identity with its own email is confirmed and linked; nothing else confirms it', async ({ db }) => {
  const { createSession } = await import('../lib/auth-db.ts')
  // same email, Google-verified, fresh session, identity free: linked AND confirmed, in one transaction
  await createPasswordUser(user('U1'), db)
  assert.equal(await verifiedAt(db, 'U1'), null, 'fixture: a new password account starts unconfirmed')
  assert.equal(await linkGoogle(db, 'U1', G('u1@example.test'), await createSession('U1', db)), 'linked')
  assert.ok(Number(await verifiedAt(db, 'U1')) > 0, 'confirmed by the link')
  assert.equal(await identities(db, 'U1'), 1)
  assert.deepEqual(await emailStatus(db, 'U1'), { email: 'u1@example.test', verified: true, google: true })
  // a different email: mismatch, still unconfirmed, nothing linked
  await createPasswordUser(user('U2'), db)
  assert.equal(await linkGoogle(db, 'U2', G('someone-else@example.test'), await createSession('U2', db)), 'mismatch')
  assert.equal(await verifiedAt(db, 'U2'), null); assert.equal(await identities(db, 'U2'), 0)
  // an identity another account already holds: taken, still unconfirmed
  await createPasswordUser(user('U3'), db)
  assert.equal(await linkGoogle(db, 'U3', G('u3@example.test', 'g-u1@example.test'), await createSession('U3', db)), 'taken')
  assert.equal(await verifiedAt(db, 'U3'), null); assert.equal(await identities(db, 'U3'), 0)
  // a stale session: reauth_required, still unconfirmed
  await createPasswordUser(user('U4'), db)
  const stale = await createSession('U4', db)
  await db.run('UPDATE sessions SET authed_at = 1 WHERE user_id = ?', ['U4'])
  assert.equal(await linkGoogle(db, 'U4', G('u4@example.test'), stale), 'reauth_required')
  assert.equal(await verifiedAt(db, 'U4'), null); assert.equal(await identities(db, 'U4'), 0)
  // an already confirmed account keeps its original confirmation time
  await createPasswordUser(user('U5'), db); await verified(db, 'U5')
  assert.equal(await linkGoogle(db, 'U5', G('u5@example.test'), await createSession('U5', db)), 'linked')
  assert.equal(Number(await verifiedAt(db, 'U5')), 1)
})
