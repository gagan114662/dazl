import assert from 'node:assert/strict'
import { createPasswordUser, createSession } from '../lib/auth-db.ts'
import { requestEmailChange, requestReset, resetPassword, verifyEmail, emailStatus } from '../lib/email-ownership.ts'
import { bothEngines } from './helpers/engines.ts'
bothEngines('password recovery invalidates an already-issued change-address token', async ({ db }) => {
 await createPasswordUser({id:'A',email:'owner@example.test',name:'Owner',business_name:'Business',password_hash:'old',salt:'salt'},db)
 await requestEmailChange(db,'A','other@example.test')
 const change=(await db.get<{body:string}>("SELECT body FROM system_mail_outbox WHERE to_email = ?",['other@example.test']))!.body.match(/#t=([a-f0-9]{64})/)![1]
 await requestReset(db,'owner@example.test')
 const recovery=(await db.get<{body:string}>("SELECT body FROM system_mail_outbox WHERE to_email = ? AND subject = ?",['owner@example.test','Reset your dazl password']))!.body.match(/#t=([a-f0-9]{64})/)![1]
 assert.equal(await resetPassword(db,recovery,{password_hash:'replacement',salt:'new-salt'}),true)
 const accepted=await verifyEmail(db,change)
 console.log('PENDING_CHANGE_AFTER_RECOVERY',db.kind,accepted,(await emailStatus(db,'A'))!.email)
 assert.equal(accepted,false,'a pre-recovery address change must not remain usable after the owner recovers the account')
 assert.equal((await emailStatus(db,'A'))!.email,'owner@example.test')
})

const tokenFor = async (db: any, email: string, subject: string) => (await db.get('SELECT body FROM system_mail_outbox WHERE to_email = ? AND subject = ? ORDER BY created_at DESC', [email, subject])).body.match(/#t=([a-f0-9]{64})/)[1]
bothEngines('invalid or expired recovery preserves pending change; new post-recovery change still works', async ({ db }) => {
 await createPasswordUser({id:'B',email:'before@example.test',name:'Owner',business_name:'Business',password_hash:'old',salt:'salt'},db)
 await requestEmailChange(db,'B','pending@example.test')
 const pending=await tokenFor(db,'pending@example.test','Confirm your new email for dazl')
 await requestReset(db,'before@example.test',1)
 const expired=await tokenFor(db,'before@example.test','Reset your dazl password')
 assert.equal(await resetPassword(db,'a'.repeat(64),{password_hash:'new',salt:'salt'}),false)
 assert.equal(await resetPassword(db,expired,{password_hash:'new',salt:'salt'}),false)
 assert.equal(await verifyEmail(db,pending),true,'invalid recovery must not invalidate another capability')
 await requestReset(db,'pending@example.test')
 const valid=await tokenFor(db,'pending@example.test','Reset your dazl password')
 assert.equal(await resetPassword(db,valid,{password_hash:'new',salt:'salt'}),true)
 await requestEmailChange(db,'B','after@example.test')
 const fresh=await tokenFor(db,'after@example.test','Confirm your new email for dazl')
 assert.equal(await verifyEmail(db,fresh),true,'freshly issued post-recovery change remains usable')
 assert.equal((await emailStatus(db,'B'))!.email,'after@example.test')
})

bothEngines('concurrent recovery and old email change cannot both commit', async ({ db }) => {
 for(let i=0;i<8;i++){
  const id=`race-${i}`,old=`owner-${i}@example.test`,next=`other-${i}@example.test`
  await createPasswordUser({id,email:old,name:'Owner',business_name:'Business',password_hash:'old',salt:'salt'},db)
  await requestEmailChange(db,id,next)
  const change=await tokenFor(db,next,'Confirm your new email for dazl')
  await requestReset(db,old)
  const reset=await tokenFor(db,old,'Reset your dazl password')
  const [recovered,changed]=await Promise.all([resetPassword(db,reset,{password_hash:'replacement',salt:'salt'}),verifyEmail(db,change)])
  assert.notEqual(recovered && changed,true,'an old address capability must not survive successful recovery')
  assert.ok(recovered || changed,'one legitimate operation must succeed')
  assert.equal((await emailStatus(db,id))!.email,recovered ? old : next)
 }
},{pgMax:4})


bothEngines('a change request admitted before recovery cannot issue through its revoked session afterwards', async ({ db }) => {
 await createPasswordUser({id:'late',email:'late@example.test',name:'Owner',business_name:'Business',password_hash:'old',salt:'salt'},db)
 const session = await createSession('late',db)
 await requestReset(db,'late@example.test')
 const recovery=await tokenFor(db,'late@example.test','Reset your dazl password')
 assert.equal(await resetPassword(db,recovery,{password_hash:'replacement',salt:'salt'}),true)
 await requestEmailChange(db,'late','attacker@example.test',Math.floor(Date.now()/1000),session)
 assert.equal(await db.get("SELECT 1 AS x FROM email_tokens WHERE user_id='late' AND purpose='change' AND used_at IS NULL"),undefined)
 const fresh=await createSession('late',db)
 await requestEmailChange(db,'late','fresh@example.test',Math.floor(Date.now()/1000),fresh)
 assert.ok(await db.get("SELECT 1 AS x FROM email_tokens WHERE user_id='late' AND purpose='change' AND used_at IS NULL"))
})
