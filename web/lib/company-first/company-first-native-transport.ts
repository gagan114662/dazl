// Private, unmounted, new-lane-only native Anthropic search transport.
import { asDb } from '../db/client.ts'
import { readTenantKey } from '../llm/key-store.ts'
import { reserveScanSpend, scanSpendContext } from '../scan/spend-cap.ts'
import { prepareDiscovery, executePrepared, DISCOVERY_STRATEGIES, type DiscoveryStrategy, type Lease, type Prepared } from './company-first-claude-request.ts'
import { companyHintsFromDynamicSearch } from './company-first-discovery-hints.ts'
import { decodeDynamicSettlement, TARIFF } from './company-first-dynamic-usage.ts'
import type { Candidate, Criteria } from './company-first-evidence.ts'
import { verifyExistingScorecardClaim, type VerifiedScorecardTicket } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'

type HintPorts = Parameters<typeof companyHintsFromDynamicSearch>[3]
export type ReviewedDiscoveryForecast = Readonly<{ strategy:DiscoveryStrategy; requestBinding:string; reserveMicros:number }>
type Approved = Readonly<{
  // Returned only by the owner-reviewed private control-plane port. Never pass
  // the hidden scorecard brief, document names, tenant data, or prompts here.
  criteria: Criteria; maxUses: number; reserveMicros: number; workspaceRevision: string; searchPlan?:readonly ReviewedDiscoveryForecast[]
}>
export interface NativeTransportPorts extends Pick<HintPorts, 'allowPublicUrl' | 'readPublicHtml'> {
  readReviewedPublicDiscovery: (ticket: VerifiedScorecardTicket, signal: AbortSignal) => Promise<Approved | null>
  // Trusted server transport injection for fenced tests; no URL or transport
  // is accepted from a request. Production uses the native Fetch implementation.
  fetcher?: typeof fetch
}
type Refusal = 'not_authorized' | 'no_public_offer' | 'key_unavailable' | 'reservation_refused'
export type NativeCompanySearch =
  | Readonly<{ state: 'refused'; reason: Refusal }>
  | Readonly<{ state: 'unsettled'; reason: 'transport' | 'response' | 'settlement' }>
  | Readonly<{ state: 'settled_no_hints'; reason: 'ineligible' | 'estimate_exceeded' | 'stale'; actualMicros: number }>
  | Readonly<{ state: 'settled'; hints: readonly Candidate[]; actualMicros: number }>
const attempts = new WeakSet<object>()
const settledCandidateCall = new WeakMap<Candidate,string>()
export const readNativeCandidateCallId = (candidate:Candidate): string|null=>settledCandidateCall.get(candidate)??null
const URL = 'https://api.anthropic.com/v1/messages'
const MAX_SEARCHES = 3
const MAX_DISCOVERY_PAGES = 8
const usdm = (n: unknown) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  const micros = Math.round(n * 1_000_000)
  return Number.isSafeInteger(micros) && micros / 1_000_000 === n ? micros : null
}
const day = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x

const nativeLane = (ticket: Pick<VerifiedScorecardTicket,'jobId'|'attempt'>) => Object.freeze({ enabled:true, approvedForPublicDynamicFiltering:true, ownKey:true,
    model:'claude-sonnet-5-5', apiVersion:'2023-06-01', scope:Object.freeze({ caseId:ticket.jobId, attempt:ticket.attempt }) })
/** Quote authority computes exact request bindings offline before approving
 * measured forecasts; this helper does not approve, reserve or dispatch. */
export function prepareNativeDiscoveryVariant(ticket: Pick<VerifiedScorecardTicket,'jobId'|'attempt'>,
  criteria:Criteria,maxUses:number,strategy:DiscoveryStrategy):Prepared|null {
  const {category,place,event,from,through}=criteria
  return prepareDiscovery(nativeLane(ticket),{companyType:category,market:place,intent:event},maxUses,{strategy,from,through})
}
async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw Error('response')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void response.body.cancel().catch(() => undefined)
    throw Error('response')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw Error('response')
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } catch {
    void reader.cancel().catch(() => undefined)
    throw Error('response')
  } finally { reader.releaseLock() }
}

export async function runCompanyFirstNativeTransport(execution: AuthorizedScorecardExecution, ports: NativeTransportPorts,
  signal: AbortSignal): Promise<NativeCompanySearch> {
  const refuse = (reason: Refusal): NativeCompanySearch => ({ state:'refused', reason })
  const ticket = execution?.ticket
  const ctx = scanSpendContext()
  // Authenticity is enforced by the private ticket store/current claim and
  // again by the canonical reservation. No caller-supplied enable or BYOK bit.
  if (signal.aborted || !ticket || ticket.lane !== 'new' || !ctx || !ctx.claudeOnly || !ctx.accountLimits ||
      ctx.tenantId !== ticket.tenantId || ctx.jobId !== ticket.jobId || ctx.attempt !== ticket.attempt ||
      ctx.scorecard?.ticket !== ticket || ctx.scorecard.lane !== 'new' || attempts.has(ctx)) return refuse('not_authorized')
  const db = asDb(ctx.db)
  if (db.kind !== 'sqlite' || !await verifyExistingScorecardClaim(db, ticket, requireScorecardWorkspace) || signal.aborted) return refuse('not_authorized')
  const scope = Object.freeze({ tenant:ticket.tenantId, job:ticket.jobId, attempt:String(ticket.attempt) })
  const lane = nativeLane(ticket)
  let offer: Approved | null
  try { offer = await ports.readReviewedPublicDiscovery(ticket, signal) } catch { return refuse('no_public_offer') }
  if (signal.aborted || !offer || !offer.criteria || offer.workspaceRevision !== ticket.workspaceRevision ||
      !Number.isSafeInteger(offer.maxUses) || offer.maxUses < 1 || offer.maxUses > MAX_SEARCHES ||
      !Number.isSafeInteger(offer.reserveMicros) || offer.reserveMicros < 1 || offer.reserveMicros > 5_000_000) return refuse('no_public_offer')
  const { category, place, event, from, through } = offer.criteria
  const criteria = Object.freeze({ category, place, event, from, through })
  if (!day(from) || !day(through) || from > through) return refuse('no_public_offer')
  const maxUses=offer.maxUses
  type Step = Readonly<{prepared:Prepared;reserveMicros:number;strategy?:DiscoveryStrategy}>
  const steps: Step[]=[]
  if (offer.searchPlan!==undefined) {
    const plan=offer.searchPlan
    if (!Array.isArray(plan)||plan.length!==DISCOVERY_STRATEGIES.length) return refuse('no_public_offer')
    for (const [i,q] of plan.entries()) {
      if(!q||q.strategy!==DISCOVERY_STRATEGIES[i]||!Number.isSafeInteger(q.reserveMicros)||q.reserveMicros<1||q.reserveMicros>5_000_000)
        return refuse('no_public_offer')
      const prepared=prepareNativeDiscoveryVariant(ticket,criteria,maxUses,q.strategy)
      if(!prepared||q.requestBinding!==prepared.binding)return refuse('no_public_offer')
      steps.push(Object.freeze({prepared,reserveMicros:q.reserveMicros,strategy:q.strategy}))
    }
    // The protected offer's envelope is the approved discovery share, not a
    // new allocation. Canonical gates still enforce lower live case/account caps.
    if(steps.reduce((n,x)=>n+x.reserveMicros,0)>offer.reserveMicros)return refuse('no_public_offer')
  } else {
    const prepared=prepareDiscovery(lane,{companyType:category,market:place,intent:event},maxUses)
    if(!prepared)return refuse('no_public_offer')
    steps.push(Object.freeze({prepared,reserveMicros:offer.reserveMicros}))
  }
  let credentials: Awaited<ReturnType<typeof readTenantKey>>
  try { credentials = await readTenantKey(db, ticket.tenantId, 'anthropic') } catch { return refuse('key_unavailable') }
  const workspaceKey = credentials.key
  if (!workspaceKey || credentials.unreadable) return refuse('key_unavailable')
  if (signal.aborted || attempts.has(ctx)) return refuse('not_authorized')
  attempts.add(ctx)
  let actualTotal=0
  const approved = new Map<string,Readonly<{reserved:number;actual:number}>>()
  const merged=new Map<string,{hint:Candidate;callId:string}>(), conflicts=new Set<string>()
  const pages=new Map<string,Awaited<ReturnType<NativeTransportPorts['readPublicHtml']>>>()
  // Do not expand public page reads in proportion to paid search calls.
  let remainingAngles=steps.length
  const readPublicHtml:NativeTransportPorts['readPublicHtml']=async(url,abort)=>{
    if(abort.aborted)return null
    if(pages.has(url))return pages.get(url)??null
    // Keep one unused slot per later angle; cache hits spend no new slot.
    if(pages.size>=MAX_DISCOVERY_PAGES-remainingAngles)return null
    pages.set(url,null)
    const page=await ports.readPublicHtml(url,abort)
    if(!abort.aborted)pages.set(url,page)
    return abort.aborted?null:page
  }
  // All existing positive calls in this attempt must be exactly the settled
  // prefix produced below. A restart has no such prefix and cannot replay.
  const joined = (reservation?:Readonly<{id:string;reserveMicros:number; actualMicros:number|null}>) => db.tx(function* (tx) {
    if (Date.now() >= ticket.expiresAt || !(yield* requireScorecardWorkspace(tx,ticket))) return false
    const owned=yield* tx.get(`SELECT 1 FROM company_scorecard_claims c JOIN company_scorecard_cohorts p ON p.cohort=c.cohort
      JOIN scan_jobs j ON j.id=c.job_id AND j.user_id=c.tenant_id AND j.attempts=c.attempt
      WHERE c.job_id=? AND c.tenant_id=? AND c.attempt=? AND c.nonce=? AND c.cohort=? AND c.lane=1 AND c.status='running'
        AND c.expires_at=? AND c.subject_mac=? AND p.next_ordinal=c.ordinal AND p.release=?
        AND p.tenant_id=c.tenant_id AND p.actor_id=? AND p.workspace_revision=? AND p.roster=?
        AND j.status='running' AND j.error IS NULL AND j.company_scorecard_claim_nonce=c.nonce
        AND j.company_scorecard_dispatch_release=? AND j.company_scorecard_dispatch_started_at IS NOT NULL`,
    [ticket.jobId,ticket.tenantId,ticket.attempt,ticket.nonce,ticket.cohort,ticket.expiresAt,ticket.subjectMac,ticket.release,
      ticket.actorId,ticket.workspaceRevision,JSON.stringify(ticket.presets),ticket.release])
    if(!owned)return false
    const rows=yield* tx.all<{id:string; linked:string|null;kind:string;attempt:number;status:string;reserve_usd:number;actual_usd:number|null;settled_at:number|null}>(`
      SELECT s.id,b.reservation_id AS linked,s.kind,s.attempt,s.status,s.reserve_usd,s.actual_usd,s.settled_at
        FROM scan_spend_calls s LEFT JOIN company_scorecard_calls b
          ON b.reservation_id=s.id AND b.tenant_id=s.user_id AND b.lane=1 AND b.nonce=?
       WHERE s.user_id=? AND s.scan_job_id=? AND s.status<>'refused' LIMIT ${DISCOVERY_STRATEGIES.length+1}`,[ticket.nonce,ticket.tenantId,ticket.jobId])
    if(rows.length!==approved.size+(reservation?1:0))return false
    return rows.every(r=>{
      if(!r.linked||r.attempt!==ticket.attempt||r.kind!=='llm.anthropic.web_search')return false
      if(reservation&&r.id===reservation.id) return usdm(r.reserve_usd)===reservation.reserveMicros&&
        (reservation.actualMicros===null?r.status==='reserved'&&r.actual_usd===null&&r.settled_at===null:
          r.status==='settled'&&r.settled_at!==null&&usdm(r.actual_usd)===reservation.actualMicros)
      const prior=approved.get(r.id)
      return !!prior&&r.status==='settled'&&r.settled_at!==null&&usdm(r.reserve_usd)===prior.reserved&&usdm(r.actual_usd)===prior.actual
    })
  }).catch(()=>false)

  for(const {prepared,reserveMicros,strategy} of steps){
    remainingAngles--
    if(signal.aborted)return {state:'settled_no_hints',reason:'stale',actualMicros:actualTotal}
    if(!await joined())return approved.size?{state:'unsettled',reason:'settlement'}:refuse('not_authorized')
    let hold: Awaited<ReturnType<typeof reserveScanSpend>>
    try { hold = await reserveScanSpend('llm.anthropic.web_search', () => reserveMicros / 1_000_000) }
    catch { return refuse('reservation_refused') }
    if (!hold) return refuse('reservation_refused')
    const holdId=hold.id
    const own=(actualMicros:number|null)=>joined({id:holdId,reserveMicros,actualMicros})
    const lease: Lease = Object.freeze({ caseId:ticket.jobId, attempt:ticket.attempt, binding:prepared.binding,
      cohort:prepared.cohort, stage:prepared.stage, reserveMicros, id:holdId })
    let began = false
    let envelope: Readonly<{status:number;body:unknown}> | undefined
    const response = await executePrepared(prepared, lease, {
      consumeLiveLease: async input => !signal.aborted && input===lease && await own(null) && !signal.aborted,
      send: async request => {
        if (request.url!==URL || request.apiVersion!=='2023-06-01' || signal.aborted) throw Error('not current')
        began = true
        const reply = await (ports.fetcher ?? fetch)(URL, { method:'POST', redirect:'error', cache:'no-store',
          signal:AbortSignal.any([signal,request.signal]),
          headers:{ 'content-type':'application/json', 'accept':'application/json', 'anthropic-version':request.apiVersion,
            'x-api-key':workspaceKey },
          body:JSON.stringify(request.body) })
        if (reply.redirected || (reply.url && reply.url!==URL) || reply.status!==200) {
          void reply.body?.cancel().catch(() => undefined)
          envelope = Object.freeze({ status:reply.status===200?0:reply.status, body:null })
          return envelope
        }
        envelope = Object.freeze({ status:reply.status, body:await boundedJson(reply,request.readLimitBytes) })
        return envelope
      },
      parse: raw => { if (!envelope || raw !== envelope) throw Error('response'); return envelope },
    })
    if (response.state !== 'parsed') {
      // Never retry ambiguous dispatch/response or treat it as $0.
      if (began) { hold.uncertain(); return { state:'unsettled', reason:'transport' } }
      try { await hold.settle(0) } catch { hold.uncertain(); return { state:'unsettled', reason:'settlement' } }
      return refuse('reservation_refused')
    }
    const cost=decodeDynamicSettlement({ tariff:TARIFF, model:'claude-sonnet-5-5', provider:'anthropic', api:'messages_2023-06-01',
      currency:'USD', tier:'standard_only',geo:'global',cache:'uncached',tool:'web_search_20260209',caller:'code_execution_20260120',
      maxUses:prepared.maxUses,maxOutput:prepared.body.max_tokens },response.result)
    if(cost.outcome!=='settled') { hold.uncertain(); return { state:'unsettled',reason:'response' } }
    const actualMicros=cost.actualMicros
    try { await hold.settle(actualMicros/1_000_000) } catch { hold.uncertain(); return { state:'unsettled',reason:'settlement' } }
    if (!await own(actualMicros)) { hold.uncertain(); return { state:'unsettled',reason:'settlement' } }
    actualTotal+=actualMicros
    if (signal.aborted) return { state:'settled_no_hints',reason:'stale',actualMicros:actualTotal }
    if (actualMicros>reserveMicros) return { state:'settled_no_hints',reason:'estimate_exceeded',actualMicros:actualTotal }
    if (!cost.evidenceEligible) return { state:'settled_no_hints',reason:'ineligible',actualMicros:actualTotal }
    const receipt=Object.freeze({id:holdId,binding:prepared.binding,reserveMicros,actualMicros})
    const hints=await companyHintsFromDynamicSearch({scope,lane,criteria,maxUses,...(strategy?{strategy}:{})},receipt,response.result,{
      allowPublicUrl:ports.allowPublicUrl,readPublicHtml,
      verifySettledCall:async (s,c,p,r,data)=>s.job===scope.job && s.tenant===scope.tenant && s.attempt===scope.attempt &&
        c.from===criteria.from && c.through===criteria.through && p.binding===prepared.binding && r===receipt && data===response.result &&
        !signal.aborted && await own(actualMicros),
      isCurrentAndSettled:async()=>!signal.aborted && await own(actualMicros),
    },signal)
    if(hints.state==='refused'&&hints.reason==='not_settled')return {state:'unsettled',reason:'settlement'}
    if(hints.state==='refused'&&hints.reason==='stale'&&!signal.aborted)return {state:'unsettled',reason:'settlement'}
    if(hints.state==='refused' && (hints.reason!=='no_bound_results'||!strategy))
      return {state:'settled_no_hints',reason:signal.aborted?'stale':'ineligible',actualMicros:actualTotal}
    if(hints.state!=='refused')for(const hint of hints.hints){
      const name=hint.name.normalize('NFC').replace(/\s+/g,' ').trim().toLowerCase()
      const prev=merged.get(name)?.hint
      if(prev&&prev.hintUrl!==hint.hintUrl) {
        // Same named companies on different domains are not a company binding.
        if(!prev.hintUrl||!hint.hintUrl||new globalThis.URL(prev.hintUrl).origin!==new globalThis.URL(hint.hintUrl).origin)conflicts.add(name)
      } else if(!prev)merged.set(name,{hint,callId:holdId})
    }
    approved.set(holdId,Object.freeze({reserved:reserveMicros,actual:actualMicros}))
  }
  if(signal.aborted)return {state:'settled_no_hints',reason:'stale',actualMicros:actualTotal}
  if(!await joined())return {state:'unsettled',reason:'settlement'}
  const hints=[...merged].filter(([name])=>!conflicts.has(name)).map(([,candidate])=>{settledCandidateCall.set(candidate.hint,candidate.callId);return candidate.hint})
  // A valid no-hint result is distinguishable from an invalid transport.
  return {state:'settled',hints,actualMicros:actualTotal}
}
