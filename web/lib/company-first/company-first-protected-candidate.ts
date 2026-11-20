import { allowStagingProof, hasSettledStagingProofAuthority, projectStagingSample, type StagingProofRequest, type StagingProof } from './scorecard-staging-proof.ts'
import type Database from 'better-sqlite3'
import { preverifyCompanyFirstDiscovery, verifySingleCanonicalDraft, readCanonicalVerifiedDraftFacts, type CanonicalDraftFacts, type CanonicalVerifiedDraftReceipt } from './company-first-canonical-discovery.ts'
import { gradeCanonicalVerifiedDrafts, isCurrentCanonicalGrading, isFinalCanonicalGrading, type CanonicalGradedDraftReceipt } from './company-first-protected-grading.ts'
import { readTenantKey } from '../llm/key-store.ts'
// Server worker composition only. No route, public API, live flag or persistence.
import { DISCOVERY_STRATEGIES } from './company-first-claude-request.ts'
import { discoverOwnedCareerSchema, matchOwnedCareerSignal, verifyReciprocalOwnedCareerSignal, type CareerSchemaObservation } from './company-first-career-schema.ts'
import { asDb } from '../db/client.ts'
import { parseRobots } from '../connectors/sitecrawl.ts'
import { htmlToText } from '../scan/fetch-page.ts'
import { scanSpendContext } from '../scan/spend-cap.ts'
import { observedSafeGet } from '../sources/http.ts'
import type { SafeGet } from '../sources/types.ts'
import { proveReciprocalCompanySite, readReciprocalOwnedPosting, type ReciprocalSiteAuthority } from './company-first-reciprocal-site.ts'
import { readNativeCandidateCallId, runCompanyFirstNativeTransport, type NativeTransportPorts } from './company-first-native-transport.ts'
import { discoverOwnedRipplingPostings, type RipplingPostingHypothesis } from './company-first-rippling.ts'
import { companyFirstPublicReader, type ObservedContactPage, type PublicPageReadAuthority } from './company-first-public-reader.ts'
import type { WebsiteProof } from './company-first-website-proof.ts'
import { createCanonicalAtsSignal, type CanonicalAtsBinding } from './company-first-canonical-ats-signal.ts'
import { atsPostingRef } from '../sources/ats-posting.ts'
import { readIssuerOwnedPosting, issueCompanyFirstWebsite, type OriginIssuerPorts } from './company-first-origin-issuer.ts'
import { runCompanyFirstFinder, type CompanyFirstFinderPorts } from './company-first-pipeline.ts'
import type { CandidateKey, Claim } from './company-first-private-proof.ts'
import type { CanonicalStagesReader } from './company-first-canonical-read.ts'
import { prepareCanonicalContact, stageCanonicalContactRow, verifyCanonicalContact, type CanonicalContactPacket } from './company-first-final-proof-adapter.ts'
import type { CompanyFirstPorts, Finding, Scope } from './company-first-evidence.ts'
import { authorizeScorecardSubject, verifyExistingScorecardClaim, type ScorecardSubjectInput } from './scorecard-admission.ts'
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
type IssuedSite=Extract<WebsiteProof,{state:'verified'}>['site']
type IssuedFinding=Extract<Finding,{state:'signal_verified'}>
export type StagedCandidate=Readonly<{id:string;packet:CanonicalContactPacket;finding:IssuedFinding;site:IssuedSite;facts:CanonicalDraftFacts;homepage?:ObservedContactPage}>
export type CanonicalRead = Readonly<{
  readCurrentProtectedSession: AuthoritySnapshot
  reviewedSubject:ScorecardSubjectInput
  prepareScratch?(input:Readonly<{primary:Database.Database;scratch:Database.Database;execution:AuthorizedScorecardExecution;signal:AbortSignal}>):Promise<boolean>
  // Existing product rule runner, operating only on the guarded scratch.
  // It must return exact keys for affirmative rows, not take candidate or
  // confidence statuses as proofs. Missing installation is unavailable.
  finishStagedCandidates(input:Readonly<{
    primary:Database.Database; scratch:Database.Database; execution:AuthorizedScorecardExecution
    candidates:readonly StagedCandidate[]; signal:AbortSignal
  }>):Promise<ReadonlyMap<string,CandidateKey>|null>
  readStages:CanonicalStagesReader
  currentCompletedPolicy?(signal:AbortSignal):Promise<boolean>
}>
export interface ProtectedCandidateBindings {
  // All optional at deployment: absence is a hard no-dispatch, never a
  // fallback or a zero learned result. Bound only by protected worker code.
  readReviewedPublicDiscovery?: (ticket: AuthorizedScorecardExecution['ticket'], signal:AbortSignal)=>Promise<Offer|null>
  independentOwner?: OwnerAuthority
  // Distinct protected reviewed policy, not fallback from a contradicted issuer.
  reciprocalOwner?: Pick<ReciprocalSiteAuthority,'reserveCurrentRead'> & Readonly<{readCurrentAuthorizedSource:AuthoritySnapshot}>
  canonical?: CanonicalRead
  publicRead?: PublicPageReadAuthority
  // Trusted current typed signal/contact adapters, each owns exact read
  // authorization. The finder hooks below are only operation admission.
  verifyDatedSignal?: ReadProtectedSignal
  readCompanySize?: CompanyFirstPorts['readCompanySize']
  canonicalAts?: Omit<CanonicalAtsBinding,'readCurrentOwnedLink'>
  canonicalCareer?: Readonly<{
    matchesRole(title:string):boolean
    matchesPlace(placeKey:string,location:CareerSchemaObservation['location']):boolean
  }>
  contact?: CompanyFirstFinderPorts['contact']
}
export type ProtectedCandidateResult = Readonly<{
  state:'held'; reason:'not_authorized'|'independent_authority_unbound'|'canonical_proof_unbound'|
    'protected_ports_unbound'|'reviewed_offer_unavailable'|'upstream_unavailable'|'upstream_unsettled'|'canonical_proof_unavailable'|'superseded_or_unsettled'
}> | Readonly<{state:'measured'; counts:Readonly<{ candidates:number; rightPlaceSignals:number; proven:number }>}>
const pendingStagingProof = new WeakMap<ProtectedCandidateResult, {ticket:AuthorizedScorecardExecution['ticket']; proof:StagingProof}>()
export async function takeSettledStagingCandidateProof(result:ProtectedCandidateResult, execution:AuthorizedScorecardExecution,
  primary:Database.Database, request:StagingProofRequest|undefined, signal:AbortSignal):Promise<StagingProof|undefined> {
  const pending=pendingStagingProof.get(result)
  if(!pending||pending.ticket!==execution.ticket) return
  pendingStagingProof.delete(result)
  return await hasSettledStagingProofAuthority(asDb(primary),execution.ticket,request,signal)?pending.proof:undefined
}
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
  bindings:ProtectedCandidateBindings | null, outerSignal:AbortSignal, scratch?:Database.Database, stagingRequest?:StagingProofRequest):Promise<ProtectedCandidateResult>{
  const signal=AbortSignal.any([outerSignal,AbortSignal.timeout(8*60_000)])
  const ticket=execution?.ticket, ctx=scanSpendContext()
  if(signal.aborted||!ticket||ticket.lane!=='new'||!ctx?.claudeOnly||!ctx.accountLimits||
     ctx.tenantId!==ticket.tenantId||ctx.jobId!==ticket.jobId||ctx.attempt!==ticket.attempt||
     ctx.scorecard?.ticket!==ticket||ctx.scorecard.lane!=='new')return held('not_authorized')
  const db=asDb(ctx.db)
  if(db.kind!=='sqlite'||!await verifyExistingScorecardClaim(db,ticket,requireScorecardWorkspace)||signal.aborted)return held('not_authorized')
  const scope=Object.freeze({tenant:ticket.tenantId,job:ticket.jobId,attempt:String(ticket.attempt)})
  const claim=Object.freeze({tenant:ticket.tenantId,job:ticket.jobId,attempt:ticket.attempt,actor:ticket.actorId})
  const primary='memory' in ctx.db ? ctx.db : null
  const verified=new Map<IssuedFinding,CanonicalVerifiedDraftReceipt>()
  const graded=new Map<IssuedFinding,CanonicalGradedDraftReceipt>()
  let gradingStarted=false
  const current=async (asked:Scope, afterNative=false)=>{
    if(signal.aborted||!eq(asked,scope)||Date.now()>=ticket.expiresAt)return false
    try {
      if(gradingStarted){
        if(!primary||!scratch||!graded.size)return false
        for(const [finding,receipt] of graded)if(!isCurrentCanonicalGrading(receipt,primary,scratch,execution,finding)&&
           !isFinalCanonicalGrading(receipt,primary,scratch,execution,finding))return false
        return !signal.aborted
      }
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
  if(!bindings)return held('independent_authority_unbound')
  const independent=bindings.independentOwner, reciprocal=bindings.reciprocalOwner
  if(independent ? !independent.readIndependentRecords||!independent.readOwnedIdentityBlocks||!independent.authorizeAndReserve||!independent.readCurrentAuthorizedSource
    : !reciprocal?.reserveCurrentRead||!reciprocal.readCurrentAuthorizedSource||!bindings.canonicalAts)return held('independent_authority_unbound')
  const ownership=independent??reciprocal!
  if(!bindings.canonical?.finishStagedCandidates||!bindings.canonical.readStages||!bindings.canonical.readCurrentProtectedSession)return held('canonical_proof_unbound')
  const {canonical, publicRead, contact, verifyDatedSignal, readReviewedPublicDiscovery}=bindings
  const reviewed=authorizeScorecardSubject(ticket,canonical.reviewedSubject)
  if(!publicRead?.reserveCurrentRead||!publicRead.isCurrent||!contact?.isCurrent||!contact.reserveBeforeDispatch||!contact.readDirectory||!contact.readBio||!contact.corroborateProfile||!verifyDatedSignal||!readReviewedPublicDiscovery)return held('protected_ports_unbound')

  const boundSnapshot=async (read:AuthoritySnapshot)=>{
    try{
      const r=await beforeAbort(signal,()=>read(claim,signal))
      return !signal.aborted && !!r && !!r.scope && eq(r.scope,scope) && r.lane==='new' && r.workspaceRevision===ticket.workspaceRevision &&
        Number.isSafeInteger(r.expiresAtMs) && r.expiresAtMs>Date.now() && r.expiresAtMs<=ticket.expiresAt ? r : null
    }catch{return null}
  }
  const bound=async (read:AuthoritySnapshot)=>!!await boundSnapshot(read)
  // An installed adapter is not proof that its exact current private session
  // and independent source are available. Resolve both before reading an offer.
  if(!await bound(ownership.readCurrentAuthorizedSource))return held('independent_authority_unbound')
  if(!await bound(canonical.readCurrentProtectedSession)||!reviewed)return held('canonical_proof_unbound')
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
  const sourceReads=companyFirstPublicReader(scope,publicAuthority)
  const homeReads=companyFirstPublicReader(scope,publicAuthority)
  const careerHypotheses=new Map<string,readonly RipplingPostingHypothesis[]>()
  const issuedSites=new Map<string,IssuedSite>()
  const ambiguousAtsOwners=new Set<string>()
  const configuredAts=bindings.canonicalAts
  const canonicalAts=configuredAts?createCanonicalAtsSignal(scope,{
    ...configuredAts,
    async readCurrentOwnedLink(s,input,abort){
      if(abort.aborted||!await current(s,true)||!await bound(ownership.readCurrentAuthorizedSource))return null
      if(ambiguousAtsOwners.has(JSON.stringify([input.companyKey,input.websiteOrigin])))return null
      const matches=[...issuedSites.values()].filter(site=>site.companyKey===input.companyKey&&site.website===input.websiteOrigin)
      const link=matches.length===1?(independent ? readIssuerOwnedPosting(matches[0],s,ticket.expiresAt) : readReciprocalOwnedPosting(matches[0],s)):null
      return link?.literalPostingHref===input.postingUrl&&!abort.aborted?link:null
    },
    async reserveCurrentPublisherRead(r){
      return !r.signal.aborted&&await current(r.scope,true)&&await configuredAts.reserveCurrentPublisherRead(r)===true
    },
  }):null
  const schemaCandidates=new Map<string,readonly CareerSchemaObservation[]>()
  const settledHints=new Map<string,string>()
  const hintKey=(x:{name:string;hintUrl?:string})=>JSON.stringify([x.name,x.hintUrl??null])
  let nativeCompleted=false, canonicalUnknown=false
  let nativeFailed:'upstream_unavailable'|'upstream_unsettled'|null=null
  type PacketScope=Parameters<typeof prepareCanonicalContact>[0]
  const checks=new Map<IssuedFinding,{ scope:PacketScope; packet:CanonicalContactPacket; site:IssuedSite; id:string }>()
  let finalized:ReadonlyMap<string,CandidateKey>=new Map()
  const finishProof:CompanyFirstFinderPorts['checkExistingHolds']=async (s,row,abort)=>{
    const exact=checks.get(row.signal)
    if(!exact)return null
    const key=finalized.get(exact.id)
    if(!key)return null
    if(key.id!==exact.id||abort.aborted||!await current(s,true)||canonical.currentCompletedPolicy&&await canonical.currentCompletedPolicy(abort)!==true){canonicalUnknown=true;return null}
    try{
      if(await verifyCanonicalContact(exact.packet,exact.scope,reviewed.subject,key,exact.site,canonical.readStages)&&
         !abort.aborted&&await current(s,true)){
        const {signal:found,contact}=row
        return {scope:s,companyKey:found.site.companyKey,website:found.site.website,identitySource:found.site.identitySource,event:found.signal.event,
          eventSource:found.signal.sourceUrl,eventDate:found.signal.date,literalQuote:found.signal.quote,person:contact.buyer.name,
          title:contact.buyer.title,buyerBio:contact.buyer.bioUrl,linkedIn:contact.buyer.linkedin,...(contact.buyer.ownRole?{ownRole:contact.buyer.ownRole}:{}),email:contact.published.address,emailSource:contact.published.sourceUrl,verdict:'ready'}
      }
    }catch{/* No fallback from an unreadable verifier. */}
    canonicalUnknown=true
    return null
  }
  if(!scratch || !scratch.memory || !primary || primary===scratch) return held('canonical_proof_unbound')
  if(canonical.prepareScratch&&await canonical.prepareScratch(Object.freeze({primary,scratch,execution,signal}))!==true)
    return held('canonical_proof_unbound')
  const result=await runCompanyFirstFinder({enabled:true,signal},scope,finderCriteria,offer.requestedTitles,{
    preverifyFinding:async (requested,finding,abort)=>{
      if(!eq(requested,scope)||!await current(scope,true))return null
      // Primary is the original canonical SQLite handle for this protected arm.
      if(!primary)return null
      const readPage:Parameters<typeof verifySingleCanonicalDraft>[4]=async (_scope,u,s)=>{
        const page=await sourceReads.readPublicHtml(u,s)
        return page?{requestedUrl:page.url,finalUrl:page.finalUrl,complete:true,page:{
          text:page.visibleText,title:'',retrievedAt:Math.floor(Date.now()/1000),
        }}:null
      }
      // Preserve exact verifier outcomes and consume the evidence later, after
      // all native/source/contact reads have finished. Do not fetch a page twice.
      let verification:CanonicalVerifiedDraftReceipt|null=null
      const result=await preverifyCompanyFirstDiscovery(primary,scratch,execution,[finding],readPage,abort,
        receipt=>{verification=receipt})
      if(result.state!=='preverified'||result.unavailableExactSources>0)return null
      if(!verification)return false
      verified.set(finding,verification)
      return true
    },
    prepareFinalHolds:async (requested,rows,abort)=>{
      if(!primary||gradingStarted||!eq(requested,scope)||abort.aborted||!await current(scope,true))return false
      const items=rows.slice(0,5).flatMap(row=>{
        const verification=verified.get(row.signal)
        return verification?[{finding:row.signal,verification}]:[]
      })
      if(items.length!==Math.min(rows.length,5))return false
      const facts=new Map<IssuedFinding,CanonicalDraftFacts>()
      for(const item of items){
        const verifiedFacts=readCanonicalVerifiedDraftFacts(item.verification,scratch,execution,item.finding)
        if(!verifiedFacts)return false
        facts.set(item.finding,verifiedFacts)
      }
      const withHomepage=[]
      for(const item of items){
        if(abort.aborted||!await current(scope,true))return false
        const homepage=await homeReads.readContactHtml(item.finding.site.website+'/',abort)
        withHomepage.push(Object.freeze({...item,homepage}))
      }
      const auth=await readTenantKey(db,ticket.tenantId,'anthropic')
      if(!auth.key||auth.unreadable||abort.aborted||!await current(scope,true))return false
      gradingStarted=true
      const receipts=await gradeCanonicalVerifiedDrafts(primary,scratch,execution,withHomepage,auth.key,abort)
      if(!receipts||receipts.length!==items.length||abort.aborted)return false
      for(const [i,item] of items.entries())graded.set(item.finding,receipts[i])
      const staged:StagedCandidate[]=[]
      for(const row of rows.slice(0,5)){
        const found=row.signal
        const grade=graded.get(found)
        const site=issuedSites.get(JSON.stringify([found.site.companyKey,found.site.website,found.site.identitySource]))
        const verifiedFacts=facts.get(found)
        if(!grade||!site||!verifiedFacts)return false
        const stageScope=Object.freeze({primary,scratch,execution,finding:found,signal:abort})
        const packet=prepareCanonicalContact(stageScope,grade,row.contact)
        if(!packet)continue
        const id=stageCanonicalContactRow(packet,stageScope)
        if(!id)return false
        checks.set(found,{scope:stageScope,packet,site,id})
        const homepage=withHomepage.find(x=>x.finding===found)?.homepage??undefined
        staged.push(Object.freeze({id,packet,finding:found,site,facts:verifiedFacts,homepage}))
      }
      if(!staged.length)return current(scope,true)
      const finished=await canonical.finishStagedCandidates(Object.freeze({primary,scratch,execution,candidates:Object.freeze(staged),signal:abort}))
      if(!finished||abort.aborted)return false
      const ids=new Set(staged.map(x=>x.id))
      if([...finished].some(([id,key])=>!ids.has(id)||id!==key.id))return false
      finalized=new Map(finished)
      return current(scope,true)
    },
    evidence:{
      reserveBeforeDispatch:async r=>eq(r.scope,scope)&&!r.signal.aborted&&await current(scope,r.stage!=='discover'),
      isCurrent:s=>current(s,nativeCompleted),
      discover:async ({signal:abort})=>{
        if(!await bound(ownership.readCurrentAuthorizedSource)||!await bound(canonical.readCurrentProtectedSession)){
          nativeFailed='upstream_unavailable';throw Error('upstream authority unavailable')
        }
        const r=await runCompanyFirstNativeTransport(execution,{...reads,readReviewedPublicDiscovery:async x=>x===ticket?offer:null},abort)
        if(r.state!=='settled'){nativeFailed=r.state==='unsettled'?'upstream_unsettled':'upstream_unavailable';throw Error('upstream unavailable')}
        for(const hint of r.hints){
          const callId=readNativeCandidateCallId(hint)
          if(callId)settledHints.set(hintKey(hint),callId)
        }
        nativeCompleted=true
        return r.hints
      },
      verifyWebsite:async ({input,signal:abort})=>{
        if(!await bound(ownership.readCurrentAuthorizedSource))return null
        const w=independent ? await issueCompanyFirstWebsite({enabled:true,signal:abort,bindOwnedPosting:!!canonicalAts},scope,input,canonicalPlaceKey,{
          ...independent,read:issuerRead,parseRobots,parsePage:htmlToText,
          authorizeAndReserve:async r=>await current(r.scope,true)&&await independent.authorizeAndReserve(r)===true,
        }) : await proveReciprocalCompanySite({enabled:true,signal:abort},scope,input,{
          readCurrentNativePosting:async (s,c,check)=>{
            const id=settledHints.get(hintKey(c))
            if(!id||!c.hintUrl||check.aborted||!await current(s,true))return null
            const source=await boundSnapshot(ownership.readCurrentAuthorizedSource)
            if(!source||check.aborted)return null
            const row=await db.get(`SELECT 1 FROM scan_spend_calls a JOIN company_scorecard_calls b
              ON b.reservation_id=a.id AND b.tenant_id=a.user_id WHERE a.id=? AND a.scan_job_id=? AND a.user_id=?
              AND a.attempt=? AND b.nonce=? AND b.lane=1 AND a.status='settled' AND a.settled_at IS NOT NULL`,
            [id,ticket.jobId,ticket.tenantId,ticket.attempt,ticket.nonce])
            return row&&!check.aborted&&Date.now()<source.expiresAtMs?{scope:s,candidateName:c.name,exactPostingUrl:c.hintUrl,settledCallId:id,expiresAtMs:source.expiresAtMs}:null
          },
          reserveCurrentRead:async r=>await current(r.scope,true)&&await reciprocal!.reserveCurrentRead(r)===true,
        })
        if(w.state!=='verified')return null
        const siteKey=JSON.stringify([w.site.companyKey,w.site.website,w.site.identitySource])
        if(canonicalAts&&issuedSites.has(siteKey))ambiguousAtsOwners.add(JSON.stringify([w.site.companyKey,w.site.website]))
        issuedSites.set(siteKey,w.site)
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
      ...(bindings.readCompanySize?{readCompanySize:async (r:Parameters<NonNullable<CompanyFirstPorts['readCompanySize']>>[0])=>
        !r.signal.aborted&&await current(r.input.scope,true)?await bindings.readCompanySize!(r):null}:{}),
      verifyDatedSignal:async r=>{
        if(canonicalAts&&r.input.event==='hiring_posting'&&r.input.postingUrl&&atsPostingRef(r.input.postingUrl)?.kind==='greenhouse'){
          const exactSite=[...issuedSites.values()].filter(site=>site.companyKey===r.input.companyKey&&site.website===r.input.websiteOrigin)
          const reviewedCareer=bindings.canonicalCareer
          if(reciprocal&&reviewedCareer&&exactSite.length===1&&await current(scope,true)){
            const own=await verifyReciprocalOwnedCareerSignal(scope,exactSite[0],r.input,careerReads.readCareerHtml,{
              role:title=>reviewedCareer.matchesRole(title),
              place:location=>reviewedCareer.matchesPlace(r.input.place,location),
            },r.signal)
            if(own&&await current(scope,true))return own
          }
          // The ATS source still gets its ordinary exact check; it cannot
          // satisfy an own-domain event requirement if the first-party read failed.
          return canonicalAts(r)
        }
        const hints=careerHypotheses.get(JSON.stringify([r.input.companyKey,r.input.websiteOrigin]))
        const schema=schemaCandidates.get(JSON.stringify([r.input.companyKey,r.input.websiteOrigin]))
        const reviewedCareer=bindings.canonicalCareer
        // A reviewed owner-published JobPosting must pass its current exact
        // role/place match. Do not retry a held, governed page via a looser reader.
        if(reviewedCareer&&r.input.event==='hiring_posting'&&!r.input.postingUrl&&schema?.some(x=>x.ownedVisibleDate)){
          if(!await current(scope,true)||!await bound(ownership.readCurrentAuthorizedSource))return null
          const proof=matchOwnedCareerSignal(scope,r.input,schema,{
            role:title=>reviewedCareer.matchesRole(title),
            place:location=>reviewedCareer.matchesPlace(r.input.place,location),
          },r.signal)
          return proof&&isRecentCompanyFirstSignal(proof.date)&&await current(scope,true)?proof:null
        }
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
  // Aggregate default. Canonical proof required per final success; no synthetic holds.
  const counts=Object.freeze({candidates:result.observed.evidence.discovered,
    rightPlaceSignals:result.observed.signal_verified,proven:result.ready.length})
  if(!allowStagingProof(ticket,stagingRequest)) return {state:'measured',counts}
  // Ephemeral minimized buffer. The worker can release it only after the
  // primary settlement CAS and a fresh owner check.
  const samples=result.ready.flatMap(row=>{
    const sample=projectStagingSample(row.signal.name,row.signal.site.website,row.contact.buyer.name)
    return sample ? [sample] : []
  }).slice(0,5)
  const heldCount=result.observed.evidence_held+result.observed.contact_held+result.observed.final_held
  const measured=Object.freeze({state:'measured' as const,counts})
  pendingStagingProof.set(measured,{ticket,proof:Object.freeze({held:heldCount,samples:Object.freeze(samples)})})
  return measured
}
