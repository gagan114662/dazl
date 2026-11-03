import type {Db,Tx,TxBody} from './db/client.ts'
import {reapSessions} from './sessions.ts'
import {reapOutbox} from './system-mail.ts'
// Deployment must not silently choose a new account-history retention policy.
export async function reapAccountHistory(db:Db,o:{now?:number;fence?:(t:Tx)=>TxBody<void>}={},env:Record<string,string|undefined>=process.env):Promise<{sessions:number;outbox:number}>{
 if(env.ACCOUNT_RETENTION_ENABLED!=='1')return {sessions:0,outbox:0}
 return {sessions:await reapSessions(db,o),outbox:await reapOutbox(db,o)}
}
