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

bothEngines("Google linking: only the verified account with the identity's email links it; never another account, never by sign-in alone", async ({ db }) => {
  await createPasswordUser(user('A'), db); await createPasswordUser(user('B'), db); await createPasswordUser(user('C'), db)
  await verified(db, 'A'); await verified(db, 'B')
  const ga = G('a@example.test')
  // Google sign-in with A's email does not reach A's account until A links it
  assert.deepEqual(await resolveUser(db, ga), { error: 'email_exists' })
  assert.equal(await linkGoogle(db, 'B', ga), 'mismatch', "B cannot take a Google identity carrying A's email")
  assert.equal(await linkGoogle(db, 'C', G('c@example.test')), 'unverified', 'an unverified account cannot link')
  assert.equal(await linkGoogle(db, 'A', ga), 'linked')
  assert.deepEqual(await resolveUser(db, ga), { user_id: 'A', created: false })
  assert.equal(await linkGoogle(db, 'A', ga), 'already')
  assert.equal(await linkGoogle(db, 'B', ga), 'taken')
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM oauth_identities'))!.n), 1)
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
