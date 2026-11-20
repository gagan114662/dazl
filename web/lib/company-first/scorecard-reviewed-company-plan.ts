// Protected company-first scan input binding. Does not mint a ticket, choose
// a profile, dispatch transport, or make a quote authoritative by itself.
import { DISCOVERY_STRATEGIES } from './company-first-claude-request.ts'
import { prepareNativeDiscoveryVariant, type ReviewedDiscoveryForecast } from './company-first-native-transport.ts'
import type { ProtectedCandidateBindings } from './company-first-protected-candidate.ts'
import { authorizeScorecardSubject, type VerifiedScorecardTicket } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import type { ReviewedDiscoveryReadPolicy } from './scorecard-discovery-read-bindings.ts'
import type { Criteria } from './company-first-evidence.ts'

type Subject = NonNullable<ReturnType<typeof authorizeScorecardSubject>>
type PlanPort = NonNullable<ProtectedCandidateBindings['readReviewedPublicDiscovery']>
const MAX_CASE_MICROS = 5_000_000
const DAY_MS = 86_400_000
const integer = (x: unknown, lo: number, hi: number): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= lo && x <= hi
const txt = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max &&
  x === x.trim() && !/[\p{C}]|https?:\/\/|\S+@\S+/iu.test(x)
const today = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) &&
  Number.isFinite(Date.parse(v)) && today(Date.parse(v)) === v
const names = (x: unknown) => Array.isArray(x) && x.length >= 1 && x.length <= 12 &&
  x.every(v => txt(v, 120)) && new Set(x.map(v => v.normalize('NFC').toLowerCase())).size === x.length

export function bindReviewedCompanyPlan(proof: Subject, execution: AuthorizedScorecardExecution, signal: AbortSignal):
  Readonly<{readReviewedPublicDiscovery: PlanPort; publicReads: ReviewedDiscoveryReadPolicy; requiresSizeProof:boolean}> | null {
  const ticket = execution.ticket
  const current = (t: VerifiedScorecardTicket, s: AbortSignal) => t === ticket && !signal.aborted && !s.aborted && Date.now() < t.expiresAt
  if (ticket.lane !== 'new' || execution.vendor !== 'anthropic' || execution.funding !== 'workspace_owned' ||
      !current(ticket,signal) || !proof?.subject.sources || !authorizeScorecardSubject(ticket,proof.subject)) return null
  try {
    const raw = JSON.parse(proof.subject.sources)?.companyFirstReviewed
    if (!raw || raw.schema !== 'company-first-reviewed-v1' || raw.source !== 'greenhouse_reciprocal' ||
        !txt(raw.category, 200) || !txt(raw.place, 200) || raw.event !== 'hiring_posting' ||
        !txt(raw.roleKey, 120) || !txt(raw.placeKey, 200) || !names(raw.postingTitles) ||
        !names(raw.buyerTitles) || !names(raw.literalOnsitePlaces) ||
        !integer(raw.maxUses, 1, 3) || !integer(raw.reserveMicros, 1, MAX_CASE_MICROS) ||
        !date(raw.from) || !date(raw.through) || raw.from > raw.through ||
        raw.through > today(Date.now()) || Date.parse(today(Date.now())) - Date.parse(raw.from) > 45 * DAY_MS) return null
    const size = raw.companySize
    if (size !== undefined && (!size || !integer(size.min, 1, 10_000_000) || !integer(size.max, size.min, 10_000_000))) return null
    const criteria: Criteria = Object.freeze({category:raw.category,place:raw.place,event:raw.event,from:raw.from,through:raw.through,
      ...(size ? {companySize:Object.freeze({min:size.min,max:size.max})}: {})})
    const searchPlan: ReviewedDiscoveryForecast[] = []
    if (raw.forecasts !== undefined) {
      if (!Array.isArray(raw.forecasts)||raw.forecasts.length !== DISCOVERY_STRATEGIES.length) return null
      for (const [i, strategy] of DISCOVERY_STRATEGIES.entries()) {
        const f=raw.forecasts[i]
        const prepared=prepareNativeDiscoveryVariant(ticket,criteria,raw.maxUses,strategy)
        if (!f || f.strategy!==strategy || !prepared || f.requestBinding!==prepared.binding ||
            !integer(f.reserveMicros, 1, raw.reserveMicros)) return null
        searchPlan.push(Object.freeze({strategy,requestBinding:prepared.binding,reserveMicros:f.reserveMicros}))
      }
      if (searchPlan.reduce((s,f)=>s+f.reserveMicros,0)>raw.reserveMicros) return null
    }
    const result=Object.freeze({criteria,requestedTitles:Object.freeze([...raw.buyerTitles]) as readonly string[],canonicalPlaceKey:raw.placeKey,
      workspaceRevision:ticket.workspaceRevision,maxUses:raw.maxUses,reserveMicros:raw.reserveMicros,
      ...(searchPlan.length ? {searchPlan:Object.freeze(searchPlan)} : {})})
    const publicReads: ReviewedDiscoveryReadPolicy=Object.freeze({tenantId:ticket.tenantId,actorId:ticket.actorId,jobId:ticket.jobId,
      nonce:ticket.nonce,release:ticket.release,workspaceRevision:ticket.workspaceRevision,expiresAtMs:Math.min(ticket.expiresAt,Date.now()+8*60_000),
      source:raw.source,roleKey:raw.roleKey,placeKey:raw.placeKey,literalTitles:Object.freeze([...raw.postingTitles]),
      literalOnsitePlaces:Object.freeze([...raw.literalOnsitePlaces])})
    return Object.freeze({readReviewedPublicDiscovery:async (t,s)=>current(t,s)?result:null,publicReads,requiresSizeProof:criteria.companySize!==undefined})
  } catch { return null }
}
