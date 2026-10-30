import type { PlayOffer } from './scan/play-offer-text'

// #349: what a page may show about a play's offer, from a /api/campaigns/[id] reply. Only a well-formed PlayOffer is
// shown; a failed read, a reply without `offer`, an empty object or any other shape is 'unreadable' (the card says it
// could not be loaded), never "no offer", never a blank choice. null only when the reply says the play has none.
export function offerFromReply(reply: unknown): PlayOffer | null | 'unreadable' {
  if (!reply || typeof reply !== 'object' || !('offer' in reply)) return 'unreadable'
  const o = (reply as { offer: unknown }).offer
  if (o === null) return null
  if (!o || typeof o !== 'object') return 'unreadable'
  const { offer, source, conflict } = o as Record<string, unknown>
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  if (source === 'conflict') {
    const c = conflict as Record<string, unknown> | null
    if (offer !== null || !c || typeof c !== 'object' || !text(c.recorded)) return 'unreadable'
    if (!(c.stated === null ? text(c.withdrawn) : text(c.stated))) return 'unreadable'
    if (c.withdrawn !== undefined && !text(c.withdrawn)) return 'unreadable'
    return o as PlayOffer
  }
  if (source === 'none') return offer === null && conflict === null ? o as PlayOffer : 'unreadable'
  if (['play', 'recorded', 'profile', 'request'].includes(source as string)) return text(offer) && conflict === null ? o as PlayOffer : 'unreadable'
  return 'unreadable'
}
