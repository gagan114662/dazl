import type {Db,Tx,TxBody} from './db/client.ts'
import {reapSessions} from './sessions.ts'
import {reapOutbox} from './system-mail.ts'
// #720: staging only (DAZL_ENV=staging) may shorten session-history retention via SESSION_RETAIN_S (seconds, floor
// 1 day) so the reaper can be proven live. Any other environment, production included, always uses the 30-day code
// constant and ignores the variable.
export function sessionRetainS(env:Record<string,string|undefined>=process.env):number|undefined{
 if(env.DAZL_ENV!=='staging')return undefined
 const n=Number(env.SESSION_RETAIN_S)
 return env.SESSION_RETAIN_S&&Number.isFinite(n)?Math.max(Math.floor(n),24*60*60):undefined
}
// Deployment must not silently choose a new account-history retention policy.
export async function reapAccountHistory(db:Db,o:{now?:number;fence?:(t:Tx)=>TxBody<void>}={},env:Record<string,string|undefined>=process.env):Promise<{sessions:number;outbox:number}>{
 if(env.ACCOUNT_RETENTION_ENABLED!=='1')return {sessions:0,outbox:0}
 return {sessions:await reapSessions(db,{...o,retainS:sessionRetainS(env)}),outbox:await reapOutbox(db,o)}
}
