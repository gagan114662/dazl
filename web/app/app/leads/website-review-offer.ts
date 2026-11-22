import { carriedWorkspaceOfferConflict, completeOffer, effectiveOffer, statedOffer } from '../../../lib/scan/play-offer-text.ts'

type Current = {offer:string|null; business:string; seller:string}
// The offer choice "Review profile first" shows (#1122): the request's own conflict with the saved offer, else a request that
// names the workspace itself ("Find leads for <workspace>") against a different saved offer, the same choice a direct run and
// the website review offer. Never a name inferred from the query: carriedWorkspaceOfferConflict needs the workspace's own name.
export function reviewOffer(query: string, current: Current) {
  const chosen = effectiveOffer({seller:null,query},current.offer)
  if (chosen.conflict) return {offer:chosen.conflict.stated ?? '',conflict:chosen.conflict}
  const reused = carriedWorkspaceOfferConflict(query,current.business,current.seller,chosen.offer)
  if (reused) return {offer:reused.stated ?? '',conflict:reused}
  return {offer:statedOffer(query) ?? chosen.offer ?? '',conflict:null}
}

export function websiteReviewOffer(query: string, current: Current, fromSite: string) {
  const chosen = effectiveOffer({seller:null,query},current.offer)
  const site = completeOffer(fromSite)
  const review = reviewOffer(query,current)
  if (review.conflict) return review
  const stated = statedOffer(query)
  if (!stated && site && chosen.offer && site.toLowerCase() !== chosen.offer.toLowerCase())
    return {offer:site,conflict:{stated:site,recorded:chosen.offer}}
  return {offer:stated ?? chosen.offer ?? site ?? '',conflict:null}
}

export function canQuoteWebsiteDraft(draft: {query:string; invalidated:boolean}|null, query:string, explicitReview:boolean):boolean {
  return !draft || (explicitReview && !draft.invalidated && draft.query===query)
}
