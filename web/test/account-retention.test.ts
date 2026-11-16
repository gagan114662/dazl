import assert from 'node:assert/strict'
import test from 'node:test'
import {bothEngines} from './helpers/engines.ts'
import {reapAccountHistory,sessionRetainS} from '../lib/account-retention.ts'
import {createPasswordUser,createSession,getSessionUser} from '../lib/auth-db.ts'
bothEngines('account history cleanup defaults OFF, explicit enable is fenced and deletes only old history',async({db})=>{
 await createPasswordUser({id:'A',email:'a@example.test',name:'A',business_name:'A',password_hash:'h',salt:'s'},db)
 await createSession('A',db)
 await db.run('UPDATE sessions SET expires_at=1')
 await db.run("INSERT INTO system_mail_outbox(id,user_id,to_email,subject,body,created_at) VALUES('old','A','a@example.test','fixture','fixture',1)")
 const now=Math.floor(Date.now()/1000)
 assert.deepEqual(await reapAccountHistory(db,{now},{}),{sessions:0,outbox:0})
 assert.deepEqual(await reapAccountHistory(db,{now},{ACCOUNT_RETENTION_ENABLED:'0'}),{sessions:0,outbox:0})
 assert.ok(await db.get('SELECT 1 FROM sessions'));assert.ok(await db.get('SELECT 1 FROM system_mail_outbox'))
 await assert.rejects(reapAccountHistory(db,{now,fence:function*(){throw Error('lost lease')}},{ACCOUNT_RETENTION_ENABLED:'1'}))
 assert.deepEqual(await reapAccountHistory(db,{now},{ACCOUNT_RETENTION_ENABLED:'1'}),{sessions:1,outbox:1})
})
bothEngines('#720 staging-only SESSION_RETAIN_S shortens session retention (floor 1 day); ignored outside staging; live sessions never reaped',async({db})=>{
 await createPasswordUser({id:'A',email:'a@example.test',name:'A',business_name:'A',password_hash:'h',salt:'s'},db)
 const now=Math.floor(Date.now()/1000),DAY=86400
 const add=(id:string,expires:number,revoked:number|null)=>db.run('INSERT INTO sessions (id, user_id, expires_at, revoked_at, public_id) VALUES (?, ?, ?, ?, ?)',[id,'A',expires,revoked,id.padEnd(24,'0')])
 await add('exp2d',now-2*DAY,null)        // expired 2 days ago
 await add('rev2d',now+DAY,now-2*DAY)     // revoked 2 days ago
 await add('exp12h',now-DAY/2,null)       // expired 12h ago: inside the 1-day floor
 const live=await createSession('A',db)  // working session
 const on={ACCOUNT_RETENTION_ENABLED:'1'}
 // production (or unset DAZL_ENV) ignores the override: 30-day default keeps all 2-day-old rows
 assert.deepEqual(await reapAccountHistory(db,{now},{...on,DAZL_ENV:'production',SESSION_RETAIN_S:String(DAY)}),{sessions:0,outbox:0})
 assert.deepEqual(await reapAccountHistory(db,{now},{...on,SESSION_RETAIN_S:String(DAY)}),{sessions:0,outbox:0})
 // staging: a value below the floor is raised to 1 day, so the 12h-old row is kept
 assert.deepEqual(await reapAccountHistory(db,{now},{...on,DAZL_ENV:'staging',SESSION_RETAIN_S:'60'}),{sessions:2,outbox:0})
 const left=(await db.all<{id:string}>('SELECT id FROM sessions ORDER BY id')).map(r=>r.id)
 assert.ok(left.includes('exp12h'));assert.ok(!left.includes('exp2d'));assert.ok(!left.includes('rev2d'))
 assert.equal(left.length,2,'live session kept')
 assert.ok(await getSessionUser(live,db))
})
test('#720 sessionRetainS: only DAZL_ENV=staging honors SESSION_RETAIN_S, floored at 1 day; production refuses it',()=>{
 assert.equal(sessionRetainS({DAZL_ENV:'production',SESSION_RETAIN_S:'86400'}),undefined)
 assert.equal(sessionRetainS({SESSION_RETAIN_S:'86400'}),undefined)
 assert.equal(sessionRetainS({DAZL_ENV:'staging'}),undefined)
 assert.equal(sessionRetainS({DAZL_ENV:'staging',SESSION_RETAIN_S:'abc'}),undefined)
 assert.equal(sessionRetainS({DAZL_ENV:'staging',SESSION_RETAIN_S:'60'}),86400)
 assert.equal(sessionRetainS({DAZL_ENV:'staging',SESSION_RETAIN_S:'172800'}),172800)
})
