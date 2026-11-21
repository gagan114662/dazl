import { carriedWorkspaceOfferConflict, completeOffer, effectiveOffer, statedOffer } from '../../../lib/scan/play-offer-text.ts'

export function websiteReviewOffer(query: string, current: {offer:string|null; business:string; seller:string}, fromSite: string) {
  const chosen = effectiveOffer({seller:null,query},current.offer)
  const site = completeOffer(fromSite)
  if (chosen.conflict) return {offer:chosen.conflict.stated ?? '', conflict:chosen.conflict}
  const stated = statedOffer(query)
  const reused = carriedWorkspaceOfferConflict(query,current.business,current.seller,chosen.offer)
  if (reused) return {offer:reused.stated ?? '',conflict:reused}
  if (!stated && site && chosen.offer && site.toLowerCase() !== chosen.offer.toLowerCase())
    return {offer:site,conflict:{stated:site,recorded:chosen.offer}}
  return {offer:stated ?? chosen.offer ?? site ?? '',conflict:null}
}

export function canQuoteWebsiteDraft(draft: {query:string; invalidated:boolean}|null, query:string, explicitReview:boolean):boolean {
  return !draft || (explicitReview && !draft.invalidated && draft.query===query)
}
