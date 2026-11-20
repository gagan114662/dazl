// Unmounted adapter: one settled dynamic search -> private company hypotheses.
// The underlying result is not proof of company ownership, intent, or activity.
import { prepareDiscovery, type Prepared } from './company-first-claude-request.ts'
import { decodeDynamicSettlement, TARIFF } from './company-first-dynamic-usage.ts'
import { projectDynamicReceipt } from './company-first-dynamic-receipt.mjs'
import type { Candidate, Criteria, Scope } from './company-first-evidence.ts'

type Lane = Parameters<typeof prepareDiscovery>[0]
type Call = Readonly<{status:number; body:unknown}>
type Confirmed = Readonly<{ scope:Scope; criteria:Criteria; lane:Lane; maxUses:number }>
type SpendReceipt = Readonly<{ id:string; binding:string; reserveMicros:number; actualMicros:number }>
type Page = Readonly<{ url:string; finalUrl:string; contentType:'text/html'; visibleText:string; jsonLd:readonly string[] }>
type Ports = Readonly<{
  // Read-only authoritative worker receipt. Bind the opaque provider response
  // and settled charge to the exact confirmed scope/attempt and request.
  verifySettledCall: (scope:Scope,criteria:Criteria,prepared:Prepared,receipt:SpendReceipt,response:Call) => Promise<boolean>
  isCurrentAndSettled: (scope:Scope) => Promise<boolean>
  // Existing guarded public static reader. No vendor renderer, redirects,
  // authentication, private address, third-party paid search or fallback.
  allowPublicUrl: (url:string) => boolean
  readPublicHtml: (url:string,signal:AbortSignal) => Promise<Page | null>
}>
const obj=(x:unknown):Record<string,unknown>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null
const arr=(x:unknown):readonly unknown[]=>Array.isArray(x)?x:[]
const int=(v:unknown,m:number)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=m
const escaped=(x:string)=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
const norm=(x:string)=>x.normalize('NFC').replace(/\s+/g,' ').trim().toLowerCase()
const day=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d\d-\d\d$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x
function publicUrl(raw:unknown):string|null{
  if(typeof raw!=='string'||raw.length>480||!raw.startsWith('https://')||/[\s\\?#]|%(?:2f|5c)/i.test(raw))return null
  try{
    const u=new URL(raw)
    return !u.username&&!u.password&&!u.port&&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(u.hostname)&&
      !/\.(?:local|localhost|internal|test|invalid|onion)$/.test(u.hostname)?u.href:null
  }catch{return null}
}
function boundedName(x:unknown):string|null{
  if(typeof x!=='string'||x.length>160||!/\p{L}/u.test(x)||/[\p{Cc}\p{Cf}@<>]|https?:\/\//u.test(x))return null
  const name=x.normalize('NFC').replace(/\s+/g,' ').trim()
  return ['confidential','unknown','anonymous'].includes(name.toLowerCase())?null:name
}
function orgName(x:unknown):string|null{
  const r=obj(x)
  return r?.['@type']==='Organization'||r?.['@type']==='Corporation'?boundedName(r.name):null
}
// Only bounded schema.org nodes that explicitly describe the current page.
// Do not attribute a publisher label/footer to an article subject, follow an
// @id remotely, infer an employer from the URL, or return organization.url.
function hintName(page:Page):string|null{
  if(typeof page.visibleText!=='string'||page.visibleText.length>65_536||!Array.isArray(page.jsonLd)||page.jsonLd.length>8)return null
  const names=new Map<string,string>()
  const visible=norm(page.visibleText)
  for(const s of page.jsonLd){
    if(typeof s!=='string'||s.length>16_384)continue
    let raw:Record<string,unknown>|null
    try{raw=obj(JSON.parse(s))}catch{continue}
    if(!raw||!['https://schema.org','https://schema.org/','http://schema.org'].includes(String(raw['@context'])))continue
    const graph=Array.isArray(raw['@graph'])?raw['@graph']:null
    if(graph&&graph.length>20)continue
    for(const node of graph??[raw]){
      const n=obj(node)
      if(!n||publicUrl(n.url)!==page.url)continue
      const x=n['@type']==='JobPosting'?orgName(n.hiringOrganization):
        n['@type']==='WebPage'?orgName(n.mainEntity):orgName(n)
      if(x){const key=norm(x);if(new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(key)}(?:$|[^\\p{L}\\p{N}])`,'u').test(visible))names.set(key,x)}
    }
  }
  return names.size===1?[...names.values()][0]:null
}

type Stop='binding'|'not_settled'|'estimate_exceeded'|'response_not_eligible'|'no_bound_results'|'stale'
export async function companyHintsFromDynamicSearch(confirmed:Confirmed,receipt:SpendReceipt,response:Call,ports:Ports,signal:AbortSignal) {
  const stop=(reason:Stop)=>({state:'refused' as const,reason,hints:[] as readonly Candidate[]})
  const scope=Object.freeze({...confirmed.scope}), criteria=Object.freeze({...confirmed.criteria})
  if(signal.aborted)return stop('stale')
  if(!day(criteria.from)||!day(criteria.through)||criteria.from>criteria.through||
    !Object.values(scope).every(v=>typeof v==='string'&&v.length>0&&v.length<=200))return stop('binding')
  const prepared=prepareDiscovery(confirmed.lane,{companyType:criteria.category,market:criteria.place,intent:criteria.event},confirmed.maxUses)
  if(!prepared||receipt.binding!==prepared.binding||!int(receipt.reserveMicros,5_000_000)||receipt.reserveMicros===0||
    !int(receipt.actualMicros,100_000_000)||typeof receipt.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(receipt.id))return stop('binding')
  const cost=decodeDynamicSettlement({tariff:TARIFF,model:'claude-sonnet-5-5',provider:'anthropic',api:'messages_2023-06-01',
    currency:'USD',tier:'standard_only',geo:'global',cache:'uncached',tool:'web_search_20260209',caller:'code_execution_20260120',
    maxUses:prepared.maxUses,maxOutput:prepared.body.max_tokens},response)
  if(cost.outcome!=='settled'||cost.actualMicros!==receipt.actualMicros)return stop('not_settled')
  if(cost.actualMicros>receipt.reserveMicros)return stop('estimate_exceeded')
  if(!cost.evidenceEligible||cost.stop!=='end_turn')return stop('response_not_eligible')
  const report=projectDynamicReceipt(response.body)
  if(report.kind!=='terminal'||!('usage' in report)||!report.usage||report.usage.searches!==cost.searches||report.errors.length||
    !report.pointers||!report.citations)return stop('response_not_eligible')
  // Derive all positions from the same in-memory receipt, not caller-provided
  // indices or arbitrary model JSON; capture sanitized URLs before any await.
  const blocks=arr(obj(response.body)?.content), urls=new Set<string>()
  for(const c of report.citations){
    if(![c.textBlock,c.citation,c.resultBlock,c.result].every(n=>int(n,256))||c.resultBlock>=c.textBlock||
      !report.pointers.some(p=>p.tool==='web_search'&&p.block===c.resultBlock&&p.item===c.result))continue
    const source=obj(blocks[c.resultBlock]), cite=obj(arr(obj(blocks[c.textBlock])?.citations)[c.citation])
    if(obj(source?.caller)?.type!=='code_execution_20260120')continue
    const v=publicUrl(obj(arr(source?.content)[c.result])?.url)
    if(v&&publicUrl(cite?.url)===v)urls.add(v)
  }
  if(!urls.size)return stop('no_bound_results')
  try{if(!await ports.verifySettledCall(scope,criteria,prepared,receipt,response))return stop('not_settled')}
  catch{return stop('not_settled')}
  async function current(){try{return !signal.aborted&&await ports.isCurrentAndSettled(scope)===true&&!signal.aborted}catch{return false}}
  const found=new Map<string,Candidate>(), collisions=new Set<string>()
  let reads=0
  for(const url of urls){
    if(reads>=8)break
    if(!await current())return stop('stale')
    let allowed=false
    try{allowed=ports.allowPublicUrl(url)===true}catch{/* refused */}
    if(!allowed)continue
    reads++
    let page:Page|null=null
    try{page=await ports.readPublicHtml(url,signal)}catch{/* no usable guarded public response */}
    if(!await current())return stop('stale')
    if(!page||page.url!==url||page.finalUrl!==url||page.contentType!=='text/html')continue
    const name=hintName(page)
    if(!name)continue
    const key=norm(name)
    if(found.has(key))collisions.add(key)
    else found.set(key,Object.freeze({name,hintUrl:url}))
  }
  return {state:'hints' as const,hints:[...found].filter(([k])=>!collisions.has(k)).map(([,x])=>x)}
}
