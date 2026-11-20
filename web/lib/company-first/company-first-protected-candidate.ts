// Server worker composition only. No route, public API, live flag or persistence.
import { DISCOVERY_STRATEGIES } from './company-first-claude-request.ts'
import { discoverOwnedCareerSchema, type CareerSchemaObservation } from './company-first-career-schema.ts'
import { asDb } from '../db/client.ts'
import { parseRobots } from '../connectors/sitecrawl.ts'
import { htmlToText } from '../scan/fetch-page.ts'
import { scanSpendContext } from '../scan/spend-cap.ts'
import { observedSafeGet } from '../sources/http.ts'
import type { SafeGet } from '../sources/types.ts'
import { runCompanyFirstNativeTransport, type NativeTransportPorts } from './company-first-native-transport.ts'
import { discoverOwnedRipplingPostings, type RipplingPostingHypothesis } from './company-first-rippling.ts'
import { companyFirstPublicReader, type PublicPageReadAuthority } from './company-first-public-reader.ts'
import { issueCompanyFirstWebsite, type OriginIssuerPorts } from './company-first-origin-issuer.ts'
import { runCompanyFirstFinder, type CompanyFirstFinderPorts } from './company-first-pipeline.ts'
import { evaluatePrivateCandidateProof, type CandidateEvidence, type CandidateKey, type Claim, type PrivateCandidateProofStore } from './company-first-private-proof.ts'
import type { CompanyFirstPorts, Scope } from './company-first-evidence.ts'
import { verifyExistingScorecardClaim } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'
import { isRecentCompanyFirstSignal } from './company-first-signal-freshness.ts'

type ReadSignalCall=Parameters<CompanyFirstPorts['verifyDatedSignal']>[0]
type ReadProtectedSignal=(x:ReadSignalCall & Readonly<{
  // Scope-bound discovery only; neither these URLs nor active listings are
  // a date or an externally permitted signal source in the evidence core.
  careerHypotheses?:readonly RipplingPostingHypothesis[]
  publicCareerSchema?:readonly CareerSchemaObservation[]
}>)=>ReturnType<CompanyFirstPorts['verifyDatedSignal']>
type ReadOffer = NativeTransportPorts['readReviewedPublicDiscovery']
type Offer = NonNullable<Awaited<ReturnType<ReadOffer>>> & Readonly<{ requestedTitles: readonly string[]; canonicalPlaceKey: string }>
type BoundLane = Readonly<{ scope:Scope; lane:'new'; workspaceRevision:string; expiresAtMs:number }>
type AuthoritySnapshot = (claim:Claim,signal:AbortSignal)=>Promise<BoundLane|null>
type OwnerAuthority = Pick<OriginIssuerPorts,'readIndependentRecords'|'readOwnedIdentityBlocks'|'authorizeAndReserve'> & Readonly<{
  readCurrentAuthorizedSource:AuthoritySnapshot
}>
type CanonicalRead = Readonly<{
  // Bound to canonical product attestations; not a finder-produced status.
  readCurrentProtectedSession: AuthoritySnapshot
  store: PrivateCandidateProofStore
  locateExactCandidate(claim:Claim,evidence:CandidateEvidence,signal:AbortSignal):Promise<CandidateKey|null>
}>
export interface ProtectedCandidateBindings {
  // All optional at deployment: absence is a hard no-dispatch, never a
  // fallback or a zero learned result. Bound only by protected worker code.
  readReviewedPublicDiscovery?: (ticket: AuthorizedScorecardExecution['ticket'], signal:AbortSignal)=>Promise<Offer|null>
  independentOwner?: OwnerAuthority
  canonical?: CanonicalRead
  publicRead?: PublicPageReadAuthority
  // Trusted current typed signal/contact adapters, each owns exact read
  // authorization. The finder hooks below are only operation admission.
  verifyDatedSignal?: ReadProtectedSignal
  contact?: CompanyFirstFinderPorts['contact']
}
export type ProtectedCandidateResult = Readonly<{
  state:'held'; reason:'not_authorized'|'independent_authority_unbound'|'canonical_proof_unbound'|
    'protected_ports_unbound'|'reviewed_offer_unavailable'|'upstream_unavailable'|'upstream_unsettled'|'canonical_proof_unavailable'|'superseded_or_unsettled'
}> | Readonly<{state:'measured'; counts:Readonly<{ candidates:number; rightPlaceSignals:number; proven:number }>}>
const held = (reason: Extract<ProtectedCandidateResult,{state:'held'}>['reason']):ProtectedCandidateResult => ({state:'held',reason})

// The issuer authorizes the exact URL and performs its own robots check before
// asking for identity. Preserve that sequence and bind raw bytes only long
// enough for its owned-block check; no other requests or response headers.
const issuerRead:SafeGet = async (url,opts)=>{
  const robots=new URL(url).pathname==='/robots.txt'
  const r=await observedSafeGet(url,{signal:opts?.signal,accept:robots?'text/plain':'text/html',userAgent:'dazl-contact-check/1.0 (+https://dazl.ai)'})
  if(!r||r.finalUrl!==url||!r.complete||r.truncated||r.location||r.contentEncoding!=='identity')return null
  if(robots && (r.status===404||r.status===410))return {status:r.status,body:''}
  if(r.status!==200 || !(robots? /^text\/plain(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i :
    /^text\/html(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i).test(r.contentType??''))return null
  if(robots&&/<\s*(?:!doctype|html\b|body\b|script\b)/i.test(r.body))return null
  return {status:r.status,body:r.body}
}
function beforeAbort<T>(signal:AbortSignal, operation:()=>Promise<T>):Promise<T|undefined>{
  if(signal.aborted)return Promise.resolve(undefined)
  return new Promise(resolve=>{
    const cancel=()=>finish(undefined)
    const finish=(x:T|undefined)=>{signal.removeEventListener('abort',cancel);resolve(x)}
    signal.addEventListener('abort',cancel,{once:true})
    void Promise.resolve().then(()=>signal.aborted?undefined:operation()).then(finish,()=>finish(undefined))
  })
}
const eq = (a:Scope,b:Scope) => a.tenant===b.tenant && a.job===b.job && a.attempt===b.attempt

export async function runProtectedCompanyFirstCandidate(execution:AuthorizedScorecardExecution,
  bindings:ProtectedCandidateBindings | null, outerSignal:AbortSignal):Promise<ProtectedCandidateResult>{
  const signal=AbortSignal.any([outerSignal,AbortSignal.timeout(8*60_000)])
  const ticket=execution?.ticket, ctx=scanSpendContext()
  if(signal.aborted||!ticket||ticket.lane!=='new'||!ctx?.claudeOnly||!ctx.accountLimits||
     ctx.tenantId!==ticket.tenantId||ctx.jobId!==ticket.jobId||ctx.attempt!==ticket.attempt||
     ctx.scorecard?.ticket!==ticket||ctx.scorecard.lane!=='new')return held('not_authorized')
  const db=asDb(ctx.db)
  if(db.kind!=='sqlite'||!await verifyExistingScorecardClaim(db,ticket,requireScorecardWorkspace)||signal.aborted)return held('not_authorized')
  const scope=Object.freeze({tenant:ticket.tenantId,job:ticket.jobId,attempt:String(ticket.attempt)})
  const claim=Object.freeze({tenant:ticket.tenantId,job:ticket.jobId,attempt:ticket.attempt,actor:ticket.actorId})
  const current=async (asked:Scope, afterNative=false)=>{
    if(signal.aborted||!eq(asked,scope)||Date.now()>=ticket.expiresAt)return false
    try {
      return await db.tx(function*(tx){
        if(!(yield* requireScorecardWorkspace(tx,ticket)))return false
        const owned=yield* tx.get(`SELECT 1 FROM scan_jobs j JOIN company_scorecard_claims c ON c.nonce=j.company_scorecard_claim_nonce
          WHERE j.id=? AND j.user_id=? AND j.attempts=? AND c.tenant_id=j.user_id AND c.job_id=j.id AND c.attempt=j.attempts
          AND j.status='running' AND j.error IS NULL AND j.company_scorecard_dispatch_started_at IS NOT NULL
          AND j.company_scorecard_dispatch_release=? AND c.nonce=? AND c.cohort=? AND c.status='running' AND c.lane=1 AND c.expires_at=? AND c.subject_mac=?`,
          [ticket.jobId,ticket.tenantId,ticket.attempt,ticket.release,ticket.nonce,ticket.cohort,ticket.expiresAt,ticket.subjectMac])
        if(!owned)return false
        const calls=yield* tx.all<{status:string;joined:string|null;kind:string; attempt:number;actual_usd:number|null;reserve_usd:number;settled_at:number|null}>(`
          SELECT s.status,s.kind,s.attempt,s.actual_usd,s.reserve_usd,s.settled_at,b.reservation_id AS joined FROM scan_spend_calls s
          LEFT JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.nonce=? AND b.tenant_id=s.user_id AND b.lane=1
          WHERE s.scan_job_id=? AND s.user_id=? AND s.status<>'refused' LIMIT ${DISCOVERY_STRATEGIES.length+1}`,
          [ticket.nonce,ticket.jobId,ticket.tenantId])
        return calls.length===0 ? !afterNative : calls.length<=DISCOVERY_STRATEGIES.length && calls.every(c=>c.attempt===ticket.attempt &&
          c.kind==='llm.anthropic.web_search' && !!c.joined && c.status==='settled' && c.settled_at!==null &&
          c.actual_usd!==null && c.actual_usd>=0 && c.actual_usd<=c.reserve_usd)
      }) && !signal.aborted
    }catch{return false}
  }
  if(!await current(scope))return held('not_authorized')
  if(!bindings?.independentOwner?.readIndependentRecords||!bindings.independentOwner.readOwnedIdentityBlocks||
     !bindings.independentOwner.authorizeAndReserve||!bindings.independentOwner.readCurrentAuthorizedSource)return held('independent_authority_unbound')
  if(!bindings.canonical?.store?.readCurrentSnapshot||!bindings.canonical.locateExactCandidate||!bindings.canonical.readCurrentProtectedSession)return held('canonical_proof_unbound')
  const {independentOwner, canonical, publicRead, contact, verifyDatedSignal, readReviewedPublicDiscovery}=bindings
  if(!publicRead?.reserveCurrentRead||!publicRead.isCurrent||!contact?.isCurrent||!contact.reserveBeforeDispatch||!contact.readDirectory||!contact.readBio||!contact.corroborateProfile||!verifyDatedSignal||!readReviewedPublicDiscovery)return held('protected_ports_unbound')

  const bound=async (read:AuthoritySnapshot)=>{
    try{
      const r=await beforeAbort(signal,()=>read(claim,signal))
      return !signal.aborted && !!r && !!r.scope && eq(r.scope,scope) && r.lane==='new' && r.workspaceRevision===ticket.workspaceRevision &&
        Number.isSafeInteger(r.expiresAtMs) && r.expiresAtMs>Date.now() && r.expiresAtMs<=ticket.expiresAt
    }catch{return false}
  }
  // An installed adapter is not proof that its exact current private session
  // and independent source are available. Resolve both before reading an offer.
  if(!await bound(independentOwner.readCurrentAuthorizedSource))return held('independent_authority_unbound')
  if(!await bound(canonical.readCurrentProtectedSession))return held('canonical_proof_unbound')
  const rawOffer=await beforeAbort(signal,()=>readReviewedPublicDiscovery(ticket,signal))
  if(!rawOffer||!rawOffer.criteria||typeof rawOffer.canonicalPlaceKey!=='string'||!rawOffer.canonicalPlaceKey.trim()||rawOffer.canonicalPlaceKey.length>200||!Array.isArray(rawOffer.requestedTitles)||!rawOffer.requestedTitles.length||
     rawOffer.requestedTitles.length>12||!rawOffer.requestedTitles.every(t=>typeof t==='string'&&t.trim()&&t.length<=120)||
     (rawOffer.searchPlan!==undefined&&!Array.isArray(rawOffer.searchPlan))||!await current(scope))return held('reviewed_offer_unavailable')
  const {category,place,event,from,through}=rawOffer.criteria
  const criteria=Object.freeze({category,place,event,from,through})
  const canonicalPlaceKey=rawOffer.canonicalPlaceKey
  const size=rawOffer.criteria.companySize
  const finderCriteria=Object.freeze({...criteria,place:canonicalPlaceKey,
    ...(size!==undefined?{companySize:Object.freeze({min:size?.min,max:size?.max})}:{})})
  const offer=Object.freeze({criteria,requestedTitles:Object.freeze([...rawOffer.requestedTitles]),maxUses:rawOffer.maxUses,
    reserveMicros:rawOffer.reserveMicros,workspaceRevision:rawOffer.workspaceRevision,
    searchPlan:rawOffer.searchPlan===undefined?undefined:Object.freeze(rawOffer.searchPlan.map(q=>Object.freeze({...q})))})
  const publicAuthority:PublicPageReadAuthority={
    reserveCurrentRead:async r=>await current(r.scope,true)&&await publicRead.reserveCurrentRead(r)===true,
    isCurrent:async s=>await current(s,true)&&await publicRead.isCurrent(s)===true,
  }
  const reads=companyFirstPublicReader(scope,publicAuthority)
  const careerReads=companyFirstPublicReader(scope,publicAuthority)
  const careerHypotheses=new Map<string,readonly RipplingPostingHypothesis[]>()
  const schemaCandidates=new Map<string,readonly CareerSchemaObservation[]>()
  let nativeCompleted=false, canonicalUnknown=false
  let nativeFailed:'upstream_unavailable'|'upstream_unsettled'|null=null
  const finishProof:CompanyFirstFinderPorts['checkExistingHolds']=async (s,row,abort)=>{
    const expected=Object.freeze({
      companyKey:row.signal.site.companyKey,website:row.signal.site.website,identitySource:row.signal.site.identitySource,
      event:row.signal.signal.event,eventSource:row.signal.signal.sourceUrl,eventDate:row.signal.signal.date,literalQuote:row.signal.signal.quote,
      buyer:row.contact.buyer.name,title:row.contact.buyer.title,buyerBio:row.contact.buyer.bioUrl,linkedin:row.contact.buyer.linkedin,
      email:row.contact.published.address,emailSource:row.contact.published.sourceUrl,
    })
    if(abort.aborted||!await current(s,true)||!await bound(canonical.readCurrentProtectedSession)){canonicalUnknown=true;return null}
    try{
      const candidate=await canonical.locateExactCandidate(claim,expected,abort)
      if(candidate&&await evaluatePrivateCandidateProof(canonical.store,claim,candidate,expected) && !abort.aborted && await current(s,true)){
        return {scope:s,companyKey:expected.companyKey,website:expected.website,eventSource:expected.eventSource,eventDate:expected.eventDate,
          person:expected.buyer,title:expected.title,linkedIn:expected.linkedin,email:expected.email,emailSource:expected.emailSource,verdict:'ready'}
      }
    }catch{/* Missing/unavailable is not a canonical held decision. */}
    canonicalUnknown=true
    return null
  }
  const result=await runCompanyFirstFinder({enabled:true,signal},scope,finderCriteria,offer.requestedTitles,{
    evidence:{
      reserveBeforeDispatch:async r=>eq(r.scope,scope)&&!r.signal.aborted&&await current(scope,r.stage!=='discover'),
      isCurrent:s=>current(s,nativeCompleted),
      discover:async ({signal:abort})=>{
        if(!await bound(independentOwner.readCurrentAuthorizedSource)||!await bound(canonical.readCurrentProtectedSession)){
          nativeFailed='upstream_unavailable';throw Error('upstream authority unavailable')
        }
        const r=await runCompanyFirstNativeTransport(execution,{...reads,readReviewedPublicDiscovery:async x=>x===ticket?offer:null},abort)
        if(r.state!=='settled'){nativeFailed=r.state==='unsettled'?'upstream_unsettled':'upstream_unavailable';throw Error('upstream unavailable')}
        nativeCompleted=true
        return r.hints
      },
      verifyWebsite:async ({input,signal:abort})=>{
        if(!await bound(independentOwner.readCurrentAuthorizedSource))return null
        const w=await issueCompanyFirstWebsite({enabled:true,signal:abort},scope,input,canonicalPlaceKey,{
          ...independentOwner,read:issuerRead,parseRobots,parsePage:htmlToText,
          authorizeAndReserve:async r=>await current(r.scope,true)&&await independentOwner.authorizeAndReserve(r)===true,
        })
        if(w.state!=='verified')return null
        if(criteria.event==='hiring_posting'&&!w.site.posting){
          // Both source adapters share the same bounded, scoped reader.
          const pages=new Map<string,ReturnType<typeof careerReads.readCareerHtml>>()
          const read:typeof careerReads.readCareerHtml=(u,readAbort)=>{
            const prior=pages.get(u);if(prior)return prior
            const newRead=careerReads.readCareerHtml(u,readAbort);pages.set(u,newRead);return newRead
          }
          const schema=await discoverOwnedCareerSchema(scope,input,w.site,criteria,read,abort)
          if(schema.length&&!abort.aborted)schemaCandidates.set(JSON.stringify([w.site.companyKey,w.site.website]),schema)
          const found=await discoverOwnedRipplingPostings(scope,input,w.site,read,abort)
          if(found.length&&!abort.aborted)careerHypotheses.set(JSON.stringify([w.site.companyKey,w.site.website]),found)
        }
        return w.site
      },
      verifyDatedSignal:async r=>{
        const hints=careerHypotheses.get(JSON.stringify([r.input.companyKey,r.input.websiteOrigin]))
        const schema=schemaCandidates.get(JSON.stringify([r.input.companyKey,r.input.websiteOrigin]))
        const signalProof = await verifyDatedSignal(Object.freeze({...r,...(hints?.length?{careerHypotheses:hints}:{}),...(schema?.length?{publicCareerSchema:schema}:{})}))
        return signalProof && isRecentCompanyFirstSignal(signalProof.date) ? signalProof : null
      },
    },
    contact:{
      ...contact,
      isCurrent:async(s,f)=>await current(s,true)&&await contact.isCurrent(s,f)===true,
      reserveBeforeDispatch:async r=>await current(r.scope,true)&&await contact.reserveBeforeDispatch(r)===true,
    },
    checkExistingHolds:finishProof,
    isCurrentAndSettled:s=>current(s,nativeCompleted),
  })
  if(nativeFailed)return held(nativeFailed)
  if(canonicalUnknown)return held('canonical_proof_unavailable')
  if(result.state!=='checked'||!nativeCompleted||!result.observed?.evidence||!await current(scope,true))return held('superseded_or_unsettled')
  // No identifiers, URLs, roles, addresses, raw observations, or Ready rows
  // come out. Canonical proof required per final success; no synthetic holds.
  return {state:'measured',counts:Object.freeze({candidates:result.observed.evidence.discovered,
    rightPlaceSignals:result.observed.signal_verified,proven:result.ready.length})}
}
