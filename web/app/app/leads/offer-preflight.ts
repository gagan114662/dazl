import { completeOffer } from '../../../lib/scan/play-offer-text.ts'
import { carriedExclusions } from '../../../lib/scan/carry-exclusions.ts'
import type { Icp } from '../../../lib/scan/icp.ts'
// Client projection of the authenticated same-endpoint choice response.
export function scanOfferConflict(status:number,value:unknown) {
  if(status!==409||!value||typeof value!=='object')return null
  const fields=value as Record<string,unknown>
  if(fields.error!=='offer_conflict'||typeof fields.saved!=='string'||(!fields.saved.trim()&&fields.incomplete!==true&&fields.ambiguous!==true)||
    (fields.stated!==null&&typeof fields.stated!=='string'))return null
  return {stated:fields.stated,saved:fields.saved,ambiguous:fields.ambiguous===true,
    ...(fields.incomplete===true?{incomplete:true}:{}),
    ...(fields.fresh_target===true?{freshTarget:true}:{}),
    ...(typeof fields.withdrawn==='string'?{withdrawn:fields.withdrawn}:{})}
}

// Only an explicit selection of the recorded offer can carry its old buyer
// in a direct run. The reviewed editor's profile is a separate server input.
export function directOfferProfile<T>(chosen:string,saved:string,carried:T|null,freshTarget=false):T|null {
  return !freshTarget&&chosen===saved?carried:null
}

// The run a direct offer choice starts: the carried profile only for the same offer, and in every case the carried
// profile's reviewed exclusions (who must never be contacted does not change with the offer).
export function directOfferRun<T>(chosen: string, saved: string, carried: T | null, freshTarget = false): { icp: T | null; carryExclude: string[] } {
  const icp = directOfferProfile(chosen, saved, carried, freshTarget)
  return { icp, carryExclude: icp ? [] : carriedExclusions(carried as unknown as Icp | null) }
}

// The reviewed Run buttons use the same completeness rule the estimate and scan routes apply to a supplied offer, so a
// button is never enabled for an offer every request would refuse.
export function offerReady(text: string): boolean {
  return completeOffer(text) !== null
}

const OFFER_REFUSED = 'Say in a few words what you sell for this play'
// What the page says when the estimate did not return one: the route's own offer refusal as written, a refused spend
// limit with its detail, otherwise a retryable failure.
export function estimateFailureCopy(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (status === 400 && b.error === OFFER_REFUSED) return OFFER_REFUSED
  if (b.detail) return `The spend limit was not accepted: ${String(b.detail).slice(0, 200)}`
  return 'Could not get a price estimate, so nothing was started. Try again.'
}
