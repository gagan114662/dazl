import { carriedExclusions } from '../../../lib/scan/carry-exclusions.ts'
import { normalizeIcp, type Icp } from '../../../lib/scan/icp.ts'
import { carriedWorkspaceOfferConflict, completeOffer, effectiveOffer, statedOffer } from '../../../lib/scan/play-offer-text.ts'

type Current = {offer:string|null; business:string; seller:string}
// The offer choice "Review profile first" shows (#1122): the request's own conflict with the saved offer, else a request that
// names the workspace itself ("Find leads for <workspace>") against a different saved offer, the same choice a direct run and
// the website review offer. Never a name inferred from the query: carriedWorkspaceOfferConflict needs the workspace's own name.
export function reviewOffer(query: string, current: Current) {
  const chosen = effectiveOffer({seller:null,query},current.offer,{newPlay:true})
  if (chosen.conflict) return {offer:chosen.conflict.stated ?? '',conflict:chosen.conflict}
  const reused = carriedWorkspaceOfferConflict(query,current.business,current.seller,chosen.offer)
  if (reused) return {offer:reused.stated ?? '',conflict:reused}
  return {offer:statedOffer(query) ?? chosen.offer ?? '',conflict:null}
}

export function websiteReviewOffer(query: string, current: Current, fromSite: string) {
  const review = reviewOffer(query,current)
  if (review.conflict) return review
  const site = completeOffer(fromSite)
  const stated = statedOffer(query)
  if (!stated && site && review.offer && site.toLowerCase() !== review.offer.toLowerCase())
    return {offer:site,conflict:{stated:site,recorded:review.offer}}
  return {offer:review.offer || site || '',conflict:null}
}

export function canQuoteWebsiteDraft(draft: {query:string; invalidated:boolean}|null, query:string, explicitReview:boolean):boolean {
  return !draft || (explicitReview && !draft.invalidated && draft.query===query)
}

// A concrete buyer in a fresh request is the target of that play. Keep reviewed
// exclusions on the existing request-only path without treating them as targeting.
export function requestConfirmationProfile(query: string, prior: Pick<Icp, 'summary'> | null, saved: unknown) {
  if (prior || !saved) return null
  const target = query.trim().replace(/^(?:find|show me|look for)\s+/i, '')
  const buyerAndPlace = /^(.*?)\s+in\s+(\p{L}.*)$/iu.exec(target)
  if (!buyerAndPlace) return null
  const [, buyer, place] = buyerAndPlace
  if (/^(?:(?:a|an|the|some)\s+)?(?:leads?|prospects?|customers?|clients?|buyers?|business(?:es)?|compan(?:y|ies)|accounts?|people|persons?)\b/i.test(buyer)) return null
  if (/^(?:need|search|my\s+area|near\s+me|the\s+(?:last|past))\b/i.test(place)) return null
  const profile = normalizeIcp(saved)
  return profile ? { carryExclude: carriedExclusions(profile) } : null
}
