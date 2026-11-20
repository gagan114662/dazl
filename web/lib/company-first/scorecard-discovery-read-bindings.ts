// Protected same-process staging composition. This grants no transport,
// model reservation, buyer gate, or finding; existing readers own all I/O.
import type { Db } from '../db/client.ts'
import type { Scope } from './company-first-evidence.ts'
import type { ProtectedCandidateBindings } from './company-first-protected-candidate.ts'
import { authorizeScorecardSubject, isStagingCaseOneTicket } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'
import { DISCOVERY_STRATEGIES } from './company-first-claude-request.ts'

type Arms=Required<Pick<ProtectedCandidateBindings,'publicRead'|'reciprocalOwner'|'canonicalAts'>>
type Subject=NonNullable<ReturnType<typeof authorizeScorecardSubject>>
export type ReviewedDiscoveryReadPolicy=Readonly<{
  // Built by the reviewed private operator composition, never from public input.
  tenantId:string; actorId:string; jobId:string; nonce:string; release:string; workspaceRevision:string; expiresAtMs:number
  source:'greenhouse_reciprocal'
  roleKey:string; literalTitles:readonly string[]
  placeKey:string; literalOnsitePlaces:readonly string[]
}>
const norm=(s:string)=>s.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase()
const safe=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\p{C}]/u.test(v)
const issued=new WeakSet<object>()
const MAX_READS=32, STAGING_CASE_READS=96, MAX_SOURCE_LIFETIME_MS=8*60_000
function endpoint(s:string):URL|null{
  if(!safe(s,500)||/[%\s\\#]/u.test(s))return null
  try{
    const url=new URL(s)
    return url.href===s&&url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)&&
      !/\.(?:localhost|local|internal|onion|test|invalid)$/i.test(url.hostname)?url:null
  }catch{return null}
}
const board=(u:URL)=>u.origin==='https://boards-api.greenhouse.io'&&!u.search&&/^\/v1\/boards\/[a-zA-Z0-9_-]+\/jobs\/[0-9]+$/.test(u.pathname)

export function bindReviewedDiscoveryReads(db:Db, proof:Subject, execution:AuthorizedScorecardExecution,
  policy:ReviewedDiscoveryReadPolicy|null):Arms|null{
  const t=execution?.ticket, now=Date.now()
  if(db.kind!=='sqlite'||!t||t.lane!=='new'||issued.has(t)||!proof||!authorizeScorecardSubject(t,proof.subject)||!policy||
    policy.source!=='greenhouse_reciprocal'||policy.tenantId!==t.tenantId||policy.actorId!==t.actorId||policy.jobId!==t.jobId||
    policy.nonce!==t.nonce||policy.release!==t.release||policy.workspaceRevision!==t.workspaceRevision||
    !Number.isSafeInteger(policy.expiresAtMs)||policy.expiresAtMs<=now||policy.expiresAtMs>Math.min(now+MAX_SOURCE_LIFETIME_MS,t.expiresAt)||
    !safe(policy.roleKey,120)||!safe(policy.placeKey,200))return null
  const literals=(values:readonly string[])=>Array.isArray(values)&&values.length>0&&values.length<=12&&values.every(x=>safe(x,120))?new Set(values.map(norm)):null
  const titles=literals(policy.literalTitles), places=literals(policy.literalOnsitePlaces)
  if(!titles||!places)return null
  issued.add(t)
  const expiresAtMs=policy.expiresAtMs, roleKey=policy.roleKey, placeKey=policy.placeKey
  const scope=Object.freeze({tenant:t.tenantId,job:t.jobId,attempt:String(t.attempt)})
  const snapshot=Object.freeze({scope,lane:'new' as const,workspaceRevision:t.workspaceRevision,expiresAtMs})
  const same=(s:Scope)=>s?.tenant===scope.tenant&&s.job===scope.job&&s.attempt===scope.attempt
  const staging=isStagingCaseOneTicket(t), maxReads=staging?STAGING_CASE_READS:MAX_READS
  const spent=new Set<string>(), repeats=new Map<string,number>(), firstPublisher=new Set<string>()
  async function allow(s:Scope, signal?:AbortSignal, settled?:string|null):Promise<boolean>{
    if(signal?.aborted||!same(s)||Date.now()>=expiresAtMs)return false
    try{
      return await db.tx(function*(tx){
        if(!(yield* requireScorecardWorkspace(tx,t)))return false
        const active=yield* tx.get(`SELECT 1 FROM scan_jobs j JOIN company_scorecard_claims c ON c.nonce=j.company_scorecard_claim_nonce
          JOIN company_scorecard_cohorts p ON p.cohort=c.cohort AND p.tenant_id=j.user_id
          WHERE j.id=? AND j.user_id=? AND j.attempts=? AND j.status='running' AND j.error IS NULL
            AND j.company_scorecard_dispatch_started_at IS NOT NULL AND j.company_scorecard_dispatch_release=?
            AND c.job_id=j.id AND c.tenant_id=j.user_id AND c.attempt=j.attempts AND c.nonce=? AND c.cohort=?
            AND c.lane=1 AND c.status='running' AND c.expires_at=? AND c.subject_mac=?
            AND p.actor_id=? AND p.workspace_revision=? AND p.release=? AND p.next_ordinal=c.ordinal AND p.roster=?`,
          [t.jobId,t.tenantId,t.attempt,t.release,t.nonce,t.cohort,t.expiresAt,t.subjectMac,t.actorId,t.workspaceRevision,t.release,JSON.stringify(t.presets)])
        if(!active)return false
        if(settled===undefined)return true // availability preflight only; no physical admission
        const rows=yield* tx.all<{id:string;proof:string|null;good:number}>(`SELECT s.id,b.reservation_id AS proof,
          CASE WHEN s.attempt=? AND s.kind='llm.anthropic.web_search' AND s.status='settled' AND s.settled_at IS NOT NULL
            AND s.actual_usd>=0 AND s.actual_usd<=s.reserve_usd THEN 1 ELSE 0 END AS good
          FROM scan_spend_calls s
          LEFT JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.tenant_id=s.user_id AND b.nonce=? AND b.lane=1
          WHERE s.scan_job_id=? AND s.user_id=? AND s.status<>'refused' LIMIT ${DISCOVERY_STRATEGIES.length+1}`,
          [t.attempt,t.nonce,t.jobId,t.tenantId])
        return rows.length>0&&rows.length<=DISCOVERY_STRATEGIES.length&&rows.every(r=>r.proof&&r.good===1)&&
          (settled===null||rows.some(r=>r.id===settled))
      })&&!signal?.aborted&&Date.now()<expiresAtMs
    }catch{return false}
  }
  async function reserve(s:Scope,signal:AbortSignal,key:string,settled:string|null){
    if(spent.size>=maxReads||spent.has(key)||!await allow(s,signal,settled)||
      signal.aborted||Date.now()>=expiresAtMs||spent.size>=maxReads||spent.has(key))return false
    spent.add(key)
    return true
  }
  const out:Arms={
    publicRead:{
      isCurrent:s=>allow(s,undefined,null),
      async reserveCurrentRead(r){
        const u=endpoint(r.exactUrl)
        if(!u||u.search||(r.step==='robots'?u.pathname!=='/robots.txt':r.step!=='html'||u.pathname==='/robots.txt'))return false
        const k='public:'+r.step+':'+u.href, count=repeats.get(k)??0
        const max=staging?(r.step==='robots'?15:5):1
        if(count>=max||!await reserve(r.scope,r.signal,k+':'+count,null))return false
        repeats.set(k,count+1)
        return true
      },
    },
    reciprocalOwner:{
      async readCurrentAuthorizedSource(c,signal){
        return c.actor===t.actorId&&await allow({tenant:c.tenant,job:c.job,attempt:String(c.attempt)},signal)?snapshot:null
      },
      async reserveCurrentRead(r){
        const u=endpoint(r.exactUrl), id=r.settledCallId
        if(!u||!safe(id,100)||u.search||
          !(r.step==='publisher'?board(u):r.step==='robots'?u.pathname==='/robots.txt':r.step==='homepage'&&u.pathname==='/'))return false
        if(!await reserve(r.scope,r.signal,'reciprocal:'+r.step+':'+u.href,id))return false
        if(r.step==='publisher')firstPublisher.add(id+':'+u.href)
        return true
      },
    },
    canonicalAts:{
      approvedRoleKey:roleKey,
      matchesRole:(key,title)=>key===roleKey&&safe(title,120)&&titles.has(norm(title)),
      matchesPlace:(key,p)=>key===placeKey&&!!p&&safe(p.literal,120)&&places.has(norm(p.literal)),
      async reserveCurrentPublisherRead(r){
        const u=endpoint(r.exactUrl), id=r.reviewVersion
        if(!u||!board(u)||!safe(id,100)||!firstPublisher.has(id+':'+u.href))return false
        return reserve(r.scope,r.signal,'canonical:publisher:'+u.href,id)
      },
    },
  }
  return Object.freeze({publicRead:Object.freeze(out.publicRead),reciprocalOwner:Object.freeze(out.reciprocalOwner),canonicalAts:Object.freeze(out.canonicalAts)})
}
