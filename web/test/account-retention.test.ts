import assert from 'node:assert/strict'
import {bothEngines} from './helpers/engines.ts'
import {reapAccountHistory} from '../lib/account-retention.ts'
import {createPasswordUser,createSession} from '../lib/auth-db.ts'
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
