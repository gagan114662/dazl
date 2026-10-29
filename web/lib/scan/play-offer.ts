// What the tenant sells, FOR ONE PLAY (#349). The business profile (users.sells) is where a new play starts; each play
// keeps the offer its research and drafting are for. Home, campaign detail, the outreach drafts of a play and the
// drafting itself all read the effective offer from here, so they cannot disagree.
//
// The effective offer of a play, in order:
//   1. the offer reviewed for this play (scan_jobs.offer): set on the review step before the scan ran, or chosen
//      later to resolve a conflict;
//   2. otherwise the offer recorded when the play was created (scan_jobs.seller, a snapshot of the profile then:
//      "<sells> - <website>"), or, for a play created before snapshots, the tenant's current selling context: the
//      Memory positioning, else the business profile's offer (what drafting used before plays had their own).
// A conflict: the play's own request states an offer ("selling CRM setup to ...") that differs from (2). Then the play
// has no effective offer until the tenant chooses one, and drafting for it is refused. A play's recorded context is
// never rewritten except by that explicit choice for that play: an old play keeps the offer it was created with.
import type { Db, DbLike } from '../db/client.ts'
import { asDb } from '../db/client.ts'

export { MAX_OFFER, isMissingSchema, cleanOffer, statedOffer, offerOfSeller, sameOffer, effectiveOffer, type OfferSource, type PlayOffer } from './play-offer-text.ts'
import { effectiveOffer, cleanOffer, isMissingSchema, type PlayOffer } from './play-offer-text.ts'

// The effective offer of one play of this tenant (null: no such play of this tenant).
export async function readPlayOffer(db: DbLike, tenantId: string, jobId: string): Promise<PlayOffer | null> {
  const d = asDb(db)
  const row = await d.get<{ offer: string | null; seller: string | null; query: string | null }>('SELECT offer, seller, query FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId])
  if (!row) return null
  return effectiveOffer(row, await profileOffer(d, tenantId))
}

// The tenant's current selling context: its Memory positioning, else the business profile's offer.
export async function profileOffer(db: Db, tenantId: string): Promise<string> {
  let positioning = ''
  try { positioning = (await db.get<{ positioning: string }>('SELECT positioning FROM tenant_memory WHERE tenant_id = ?', [tenantId]))?.positioning ?? '' } catch (e) { if (!isMissingSchema(e)) throw e /* else: no Memory table yet */ }
  if (positioning.trim()) return positioning
  return (await db.get<{ sells: string | null }>('SELECT sells FROM users WHERE id = ?', [tenantId]))?.sells ?? ''
}

// Sets the offer of one play of this tenant, and nothing else: the profile and every other play keep theirs.
export async function setPlayOffer(db: Db, tenantId: string, jobId: string, offer: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const o = cleanOffer(offer)
  if (o.length < 3) return false
  return (await db.run('UPDATE scan_jobs SET offer = ?, offer_set_at = ? WHERE id = ? AND user_id = ?', [o, now, jobId, tenantId])).changes === 1
}
