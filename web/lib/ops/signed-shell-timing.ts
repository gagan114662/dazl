import { createHmac, timingSafeEqual } from 'node:crypto'
import { getMasterKey } from '../secrets.ts'
import { isStaging, type Env } from '../staging.ts'
import { isRequestId } from './request-log.ts'

export type ShellRoute = '/app' | '/app/business' | '/app/plays'
export const SHELL_TIMING_ROUTE_HEADER = 'x-dazl-shell-timing-route'
export function shellRoute(v:unknown):ShellRoute|null {
  return v==='/app'||v==='/app/business'||v==='/app/plays'?v:null
}
export function shellTimingEnabled(env: Env = process.env):boolean {
  return env.DAZL_SIGNED_SHELL_TIMING === '1' || (env.DAZL_SIGNED_SHELL_TIMING === undefined && isStaging(env))
}
export function sqliteContention(err:unknown):'busy'|'locked'|null{
  try{
    const code=(err as {code?:unknown}|null)?.code
    if(typeof code!=='string')return null
    if(/^SQLITE_BUSY(?:_[A-Z0-9]+)?$/.test(code))return 'busy'
    if(/^SQLITE_LOCKED(?:_[A-Z0-9]+)?$/.test(code))return 'locked'
  }catch{/* never inspect or log exception text */}
  return null
}
const TTL_MS=60_000
function shellMac(route:ShellRoute,id:string,until:number,cookie:string,key:Buffer){
  return createHmac('sha256',key).update(JSON.stringify(['signed-shell-timing-v1',route,id,until,cookie])).digest('hex')
}
export function issueShellTimingReceipt(route:ShellRoute,id:string,cookie:string,now=Date.now(),key?:Buffer):string|null{
  try{
    if(!isRequestId(id)||!cookie||!Number.isSafeInteger(now))return null
    const until=now+TTL_MS
    return `${id}.${until}.${shellMac(route,id,until,cookie,key??getMasterKey())}`
  }catch{return null}
}
export function verifyShellTimingReceipt(route:ShellRoute,id:string,receipt:string,cookie:string,now=Date.now(),key?:Buffer):boolean{
  try{
    if(!isRequestId(id)||!cookie||!Number.isSafeInteger(now))return false
    const [,untilText,signature]=receipt.split('.')
    const until=Number(untilText)
    if(!/^[a-f0-9]{64}$/.test(signature)||!Number.isSafeInteger(until)||until<=now||until-now>TTL_MS||
      receipt!==`${id}.${until}.${signature}`)return false
    return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(shellMac(route,id,until,cookie,key??getMasterKey()),'hex'))
  }catch{return false}
}
type Phase = Readonly<{phase:'proxy_auth'|'layout_auth'; duration_ms:number; result:'allowed'|'denied'|'error'; sqlite:'busy'|'locked'|null}>
export type BrowserShellTiming = Readonly<{kind:'signed_shell_timing';route:ShellRoute;request_id:string;receipt:string;ttfb_ms:number|null;auth_marker_ms:number|null;js_failed:number;css_failed:number;observation:'load'|'deadline'|'pagehide'}>
const browserKeys = ['kind','route','request_id','receipt','ttfb_ms','auth_marker_ms','js_failed','css_failed','observation'].sort().join('|')
function bounded(v:unknown,max:number):v is number{
  return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max
}
export function parseBrowserShellTiming(v:unknown):BrowserShellTiming|null{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==browserKeys)return null
  const a=v as Record<string,unknown>,route=shellRoute(a.route)
  if(a.kind!=='signed_shell_timing'||!route||!isRequestId(a.request_id)||typeof a.receipt!=='string'||a.receipt.length>130||
    !(a.ttfb_ms===null||bounded(a.ttfb_ms,120000))||!(a.auth_marker_ms===null||bounded(a.auth_marker_ms,120000))||
    !bounded(a.js_failed,8)||!bounded(a.css_failed,8)||(a.observation!=='load'&&a.observation!=='deadline'&&a.observation!=='pagehide'))return null
  return {kind:'signed_shell_timing',route,request_id:a.request_id,receipt:a.receipt,ttfb_ms:a.ttfb_ms,auth_marker_ms:a.auth_marker_ms,
    js_failed:a.js_failed,css_failed:a.css_failed,observation:a.observation}
}
export function shellTimingBrowserKind(v:unknown):boolean{
  return !!v&&typeof v==='object'&&(v as {kind?:unknown}).kind==='signed_shell_timing'
}
function emit(data:unknown):void{
  try{process.stdout.write(JSON.stringify(data)+'\n')}catch{/* diagnostics never change responses */}
}
export function logShellAuth(route:ShellRoute|null,requestId:unknown,phase:Phase['phase'],start:number,
  result:Phase['result'],err?:unknown):void{
  if(!route||!isRequestId(requestId)||!Number.isFinite(start))return
  emit({level:'info',type:'signed_shell_timing',ts:new Date().toISOString(),route,request_id:requestId,phase,
    duration_ms:Math.round(Math.min(120000,Math.max(0,performance.now()-start))),result,sqlite:sqliteContention(err)})
}
export async function measureShellAuth(route:ShellRoute|null,requestId:unknown,phase:Phase['phase'],
  check:()=>Promise<boolean>):Promise<boolean>{
  if(!route||!isRequestId(requestId))return check()
  const start=performance.now()
  let signed:boolean
  try{signed=await check()}
  catch(error){
    logShellAuth(route,requestId,phase,start,'error',error)
    throw error
  }
  logShellAuth(route,requestId,phase,start,signed?'allowed':'denied')
  return signed
}
export function logShellBrowser(report:BrowserShellTiming):void{
  const clean=parseBrowserShellTiming(report)
  if(!clean)return
  const {route,request_id,ttfb_ms,auth_marker_ms,js_failed,css_failed,observation}=clean
  emit({level:'info',type:'signed_shell_timing',ts:new Date().toISOString(),route,request_id,phase:'browser_document',
    ttfb_ms,auth_marker_ms,js_failed,css_failed,observation})
}
