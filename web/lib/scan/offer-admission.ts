// #1436 follow-up: the offer check POST /api/scan runs, shared with POST /api/scan/estimate, so a request that names a
// different offer than the saved profile asks which one BEFORE the cost panel (live check on prod 70671839 went
// straight to the cost panel on the saved, unrelated profile). Read-only: nothing is queued, reserved or called. The
// caller supplies the reads (seller line, a confirmed offer for this exact request, the tenant's offer).
import { cleanOffer, effectiveOffer } from './play-offer-text.ts'

export type OfferAdmission =
  | { ok: true }
  | { ok: false; status: 409; body: { error: 'offer_conflict'; stated: string | null; saved: string; ambiguous?: true; withdrawn?: string } }
  | { ok: false; status: 503; body: { error: 'offer_unreadable' }; cause: unknown }

export interface OfferReads {
  sellerLine(): Promise<string>
  confirmedOffer(seller: string): Promise<string | null>
  tenantOffer(): string | null
}

export async function offerAdmission(query: string, bodyOffer: unknown, reads: OfferReads): Promise<OfferAdmission> {
  if (query.length < 3) return { ok: true }
  if (bodyOffer !== undefined && bodyOffer !== null && cleanOffer(bodyOffer).length >= 3) return { ok: true }
  try {
    const seller = await reads.sellerLine()
    if (await reads.confirmedOffer(seller)) return { ok: true }
    const e = effectiveOffer({ seller, query }, reads.tenantOffer())
    if (!e.conflict) return { ok: true }
    const c = e.conflict
    return { ok: false, status: 409, body: { error: 'offer_conflict', stated: c.stated, saved: c.recorded, ...(c.ambiguous ? { ambiguous: true as const } : {}), ...(c.withdrawn ? { withdrawn: c.withdrawn } : {}) } }
  } catch (cause) {
    return { ok: false, status: 503, body: { error: 'offer_unreadable' }, cause }
  }
}
