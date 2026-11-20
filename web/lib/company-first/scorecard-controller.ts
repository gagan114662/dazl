// Unmounted protected control plane. No route, environment secret access,
// provider, retry, model fallback, or logging. The host supplies trusted
// stores and exact approved adapters; the caller gets anonymous counts only.
export type PrivateIntent = Readonly<{ business:string; place:string; buyer:string }>
export type RunScope = Readonly<{ run:string; tenant:string; actor:string; release:string; workspaceRevision:string }>
export type OrderedArm = 'old'|'new'|'judge'
type Stop = 'approval_refused'|'input_invalid'|'intent_unproven'|'approval_changed'|'funding_refused'|'arm_unavailable'|'receipt_unproven'|'accounting_unknown'|'budget_exceeded'
type Reviewed = Readonly<{
  // Keyed attestation from the authoritative reviewed normalization, never an
  // unkeyed hash of a private case; provide identical object for all siblings.
  digest:string; query:string; icp:string; event:string; sourcePolicy:string;
  sources:string|null; seller:string|null; offer:string|null;
}>
type CaseBinding = Readonly<{ scope:RunScope; ordinal:number; reviewedDigest:string }>
type Amounts = Readonly<Record<OrderedArm,number>>
type Budget = Readonly<{ binding:CaseBinding; hold:string; amounts:Amounts }>
type ArmBinding = Readonly<{ case:CaseBinding; arm:OrderedArm; job:string; attempt:number; hold:string; reservationLimitMicros:number }>
type EvidenceCounts = Readonly<{ candidates:number; rightPlace:number; proven:number }>
type Terminal = Readonly<{ binding:ArmBinding; state:'settled'; actualMicros:number; counts:EvidenceCounts }>
type Other = Readonly<{ state:'unknown'|'refused'; binding:ArmBinding }>
export interface ProtectedControllerPorts {
  // Durable single-use approval under current workspace membership/revision and
  // exact release; consume before any arm can be armed. A false/ambiguous
  // result may never be replayed by this controller.
  consumeReviewedRun(scope:RunScope):Promise<boolean>
  loadPrivateCases(scope:RunScope):Promise<unknown>
  // Bind one frozen authoritative review to the ordinal and supplied case;
  // return null if event, timing, policy or normalized target was not reviewed.
  resolveReviewedIntent(scope:RunScope,ordinal:number,input:PrivateIntent):Promise<Reviewed|null>
  authorizationStillCurrent(binding:CaseBinding):Promise<boolean>
  // Atomically reserve exact quote exposure across both finders and judge under
  // same case/run caps + canonical account constraints. Caller cannot infer
  // that budget is available, allocate extra, or release uncertainty.
  reserveReviewedCase(binding:CaseBinding,reviewed:Reviewed):Promise<Budget|null>
  // Protected signer issues and arms a distinct canonical job/lane, after
  // durable ordering/current checks. It binds exact scope, subject and hold.
  armSignedJob(budget:Budget,arm:OrderedArm,reviewed:Reviewed):Promise<ArmBinding|null>
  // Actual adapters must use canonical per-job reservation and private scratch.
  // Return settlement only from durable authoritative ledgers; counts only
  // from authoritative observations/gates, never synthesized from a mock.
  executeOnce(binding:ArmBinding,reviewed:Reviewed):Promise<Terminal|Other|null>
}
type SafeArm = Readonly<{candidates:number|null; rightPlace:number|null; proven:number|null; actualMicros:number}>
type SafeCase = Readonly<{ordinal:number; old:SafeArm|null; new:SafeArm|null; judge:SafeArm|null}>
export type ControllerResult =
 | {state:'complete';cases:readonly SafeCase[]}
 | {state:'partial';cases:readonly SafeCase[];stop:Readonly<{reason:Stop;ordinal:number|null;arm:OrderedArm|null}>}
const ARMS = ['old','new','judge'] as const
const CASE_LIMIT = 5_000_000, RUN_LIMIT = 35_000_000
const sha = (v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const optionalText = (x:unknown,max:number)=>x===null||text(x,max)
const id = (v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v)
const text = (v:unknown,max:number):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&Buffer.byteLength(v)<=max&&!/[\u0000-\u001f\u007f]/u.test(v)
const num = (v:unknown,limit=CASE_LIMIT):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=limit
const obj = (v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const exact = (v:unknown, keys:readonly string[])=>obj(v)&&keys.length===Object.keys(v).length&&keys.every(k=>Object.hasOwn(v,k))
const scopeSame=(a:RunScope,b:RunScope)=>!!a&&a.run===b.run&&a.tenant===b.tenant&&a.actor===b.actor&&a.release===b.release&&a.workspaceRevision===b.workspaceRevision
const caseSame=(a:CaseBinding,b:CaseBinding)=>!!a&&scopeSame(a.scope,b.scope)&&a.ordinal===b.ordinal&&a.reviewedDigest===b.reviewedDigest
const armSame=(a:ArmBinding,b:ArmBinding)=>!!a&&caseSame(a.case,b.case)&&a.arm===b.arm&&a.job===b.job&&a.attempt===b.attempt&&a.hold===b.hold&&a.reservationLimitMicros===b.reservationLimitMicros
const resultCounts=(v:EvidenceCounts)=>!!v&&num(v.candidates,5000)&&num(v.rightPlace,5000)&&num(v.proven,5000)&&v.proven<=v.rightPlace&&v.rightPlace<=v.candidates
function privateCases(raw:unknown):readonly PrivateIntent[]|null {
  if(!Array.isArray(raw)||raw.length!==7)return null
  const rows:PrivateIntent[]=[]
  for(const row of raw){
    if(!obj(row)||!exact(row,['business','place','buyer'])||!text(row.business,240)||!text(row.place,240)||!text(row.buyer,240))return null
    rows.push(Object.freeze({business:row.business,place:row.place,buyer:row.buyer}))
  }
  return new Set(rows.map(row=>JSON.stringify(row))).size===7?Object.freeze(rows):null
}
const invoke=async<T>(fn:()=>Promise<T>):Promise<T|null>=>{try{return await fn()}catch{return null}}

export async function runProtectedScorecardOnce(rawScope:RunScope,p:ProtectedControllerPorts):Promise<ControllerResult>{
  const scope=Object.freeze({...rawScope})
  const cases:SafeCase[]=[]
  const stop=(reason:Stop,ordinal:number|null=null,arm:OrderedArm|null=null):ControllerResult=>
    ({state:'partial',cases:[...cases],stop:{reason,ordinal,arm}})
  if(!sha(scope.run)||!sha(scope.workspaceRevision)||!id(scope.tenant)||!id(scope.actor)||!/^[a-f0-9]{40}$/.test(scope.release))return stop('approval_refused')
  if(await invoke(()=>p.consumeReviewedRun(scope))!==true)return stop('approval_refused')
  const inputs=privateCases(await invoke(()=>p.loadPrivateCases(scope)))
  if(!inputs)return stop('input_invalid')
  let runSpend=0
  const jobs=new Set<string>(), holds=new Set<string>(), intentDigests=new Set<string>()
  for(const [i,input] of inputs.entries()){
    const ordinal=i+1
    const row:{ordinal:number;old:SafeArm|null;new:SafeArm|null;judge:SafeArm|null}={ordinal,old:null,new:null,judge:null}
    cases.push(row)
    const v=await invoke(()=>p.resolveReviewedIntent(scope,ordinal,input))
    if(!v||!exact(v,['digest','query','icp','event','sourcePolicy','sources','seller','offer'])||!sha(v.digest)||intentDigests.has(v.digest)||
       !text(v.query,600)||!text(v.icp,32768)||!text(v.event,160)||!text(v.sourcePolicy,200)||!optionalText(v.sources,8192)||!optionalText(v.seller,300)||!optionalText(v.offer,150))return stop('intent_unproven',ordinal)
    intentDigests.add(v.digest)
    const reviewed=Object.freeze({...v})
    const binding=Object.freeze({scope,ordinal,reviewedDigest:reviewed.digest})
    if(await invoke(()=>p.authorizationStillCurrent(binding))!==true)return stop('approval_changed',ordinal)
    const reserved=await invoke(()=>p.reserveReviewedCase(binding,reviewed))
    if(!reserved||!caseSame(reserved.binding,binding)||!sha(reserved.hold)||holds.has(reserved.hold)||
       !exact(reserved.amounts,ARMS)||ARMS.some(a=>!num(reserved.amounts[a])||reserved.amounts[a]===0))return stop('funding_refused',ordinal)
    const whole=ARMS.reduce((n,a)=>n+reserved.amounts[a],0)
    if(whole>CASE_LIMIT||runSpend+whole>RUN_LIMIT)return stop('budget_exceeded',ordinal)
    holds.add(reserved.hold)
    const budget=Object.freeze({binding,hold:reserved.hold,amounts:Object.freeze({...reserved.amounts})})
    let caseSpend=0
    for(const arm of ARMS){
      if(await invoke(()=>p.authorizationStillCurrent(binding))!==true)return stop('approval_changed',ordinal,arm)
      const x=await invoke(()=>p.armSignedJob(budget,arm,reviewed))
      if(!x||!caseSame(x.case,binding)||x.arm!==arm||typeof x.job!=='string'||!/^[a-f0-9]{24}$/.test(x.job)||jobs.has(x.job)||
         x.attempt!==1||x.hold!==budget.hold||x.reservationLimitMicros!==budget.amounts[arm])return stop('arm_unavailable',ordinal,arm)
      jobs.add(x.job)
      const exactArm=Object.freeze({case:binding,arm,job:x.job,attempt:x.attempt,hold:x.hold,reservationLimitMicros:x.reservationLimitMicros})
      if(await invoke(()=>p.authorizationStillCurrent(binding))!==true)return stop('approval_changed',ordinal,arm)
      const r=await invoke(()=>p.executeOnce(exactArm,reviewed))
      if(!r||!armSame(r.binding,exactArm))return stop(r?'receipt_unproven':'accounting_unknown',ordinal,arm)
      if(r.state!=='settled')return stop(r.state==='refused'?'arm_unavailable':'accounting_unknown',ordinal,arm)
      if(!num(r.actualMicros,Number.MAX_SAFE_INTEGER))return stop('accounting_unknown',ordinal,arm)
      const actualMicros=r.actualMicros
      // Known settlement stays truthful even on overrun/invalid proof; don't
      // report a qualified/inconclusive count or pretend no charge occurred.
      row[arm]={candidates:null,rightPlace:null,proven:null,actualMicros}
      if(actualMicros>budget.amounts[arm]||caseSpend+actualMicros>CASE_LIMIT||runSpend+actualMicros>RUN_LIMIT)
        return stop('budget_exceeded',ordinal,arm)
      if(!resultCounts(r.counts))return stop('receipt_unproven',ordinal,arm)
      const {candidates,rightPlace,proven}=r.counts
      if(await invoke(()=>p.authorizationStillCurrent(binding))!==true)return stop('approval_changed',ordinal,arm)
      caseSpend+=actualMicros;runSpend+=actualMicros
      row[arm]={candidates,rightPlace,proven,actualMicros}
    }
  }
  return {state:'complete',cases}
}
