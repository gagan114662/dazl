// #1436 follow-up: the offer check POST /api/scan runs, shared with POST /api/scan/estimate, so a request that names a
// different offer than the saved profile asks which one BEFORE the cost panel (live check on prod 70671839 went
// straight to the cost panel on the saved, unrelated profile). Read-only: nothing is queued, reserved or called.
import { readSellerLine } from '../auth-db.ts'
import { getScanDb } from './service.ts'
import { cleanOffer, confirmedPlayOffer, effectiveOffer } from './play-offer.ts'
import { readTenantOffer } from '../outreach/play-memory.ts'

export type OfferAdmission =
  | { ok: true }
  | { ok: false; status: 409; body: { error: 'offer_conflict'; stated: string | null; saved: string; ambiguous?: true; withdrawn?: string } }
  | { ok: false; status: 503; body: { error: 'offer_unreadable' }; cause: unknown }

export async function offerAdmission(db: Parameters<typeof readSellerLine>[0], tenantId: string, query: string, bodyOffer: unknown): Promise<OfferAdmission> {
  if (query.length < 3) return { ok: true }
  if (bodyOffer !== undefined && bodyOffer !== null && cleanOffer(bodyOffer).length >= 3) return { ok: true }
  try {
    const seller = await readSellerLine(db, tenantId)
    if ((await confirmedPlayOffer(getScanDb(), tenantId, query, seller))?.offer) return { ok: true }
    const e = effectiveOffer({ seller, query }, readTenantOffer(getScanDb(), tenantId))
    if (!e.conflict) return { ok: true }
    const c = e.conflict
    return { ok: false, status: 409, body: { error: 'offer_conflict', stated: c.stated, saved: c.recorded, ...(c.ambiguous ? { ambiguous: true as const } : {}), ...(c.withdrawn ? { withdrawn: c.withdrawn } : {}) } }
  } catch (cause) {
    return { ok: false, status: 503, body: { error: 'offer_unreadable' }, cause }
  }
}
