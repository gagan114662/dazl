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
import { readSellerLine, readSellerProfile } from '../auth-db.ts'

export { MAX_OFFER, isMissingSchema, cleanOffer, statedOffer, offerOfSeller, sameOffer, effectiveOffer, storedPlayOffer, type OfferSource, type PlayOffer } from './play-offer-text.ts'
import { storedPlayOffer, cleanOffer, isMissingSchema, tenantOffer, type PlayOffer } from './play-offer-text.ts'

// The effective offer of one play of this tenant (null: no such play of this tenant). A play that never recorded an offer
// comes back unconfirmed (storedPlayOffer, #687), never as if its current-profile fallback had been recorded. Read only.
export async function readPlayOffer(db: DbLike, tenantId: string, jobId: string): Promise<PlayOffer | null> {
  const d = asDb(db)
  const row = await d.get<{ offer: string | null; seller: string | null; query: string | null }>('SELECT offer, seller, query FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId])
  if (!row) return null
  return storedPlayOffer(row, await profileOffer(d, tenantId))
}

// The tenant's own selling context (play-offer-text.ts tenantOffer): the Memory positioning, else the business
// profile's offer; '' when neither is set.
export async function profileOffer(db: Db, tenantId: string): Promise<string> {
  let positioning = ''
  try { positioning = (await db.get<{ positioning: string }>('SELECT positioning FROM tenant_memory WHERE tenant_id = ?', [tenantId]))?.positioning ?? '' } catch (e) { if (!isMissingSchema(e)) throw e /* else: no Memory table yet */ }
  if (positioning.trim()) return tenantOffer(positioning, '') ?? ''
  let sells = ''
  try { sells = (await db.get<{ sells: string | null }>('SELECT sells FROM users WHERE id = ?', [tenantId]))?.sells ?? '' } catch (e) { if (!isMissingSchema(e)) throw e /* else: no profile table */ }
  return tenantOffer('', sells) ?? ''
}

// The offer a NEW play of this tenant starts from, before its request is read (#349): the business profile's offer, else
// the tenant's Memory positioning - the base POST /api/scan checks a direct run against (effectiveOffer: the seller line
// snapshot, else readTenantOffer). The review step on Find leads compares a request with this, so a reviewed run warns
// about the same conflicts a direct run is refused for. A website alone states no offer. null: nothing is saved.
export async function newPlayOffer(db: Db, tenantId: string, profileSells: string): Promise<string | null> {
  return cleanOffer(profileSells) || cleanOffer(await profileOffer(db, tenantId)) || null
}

// The offer this tenant last CONFIRMED for this exact request (#349): a play with the same request whose offer was
// reviewed or chosen (scan_jobs.offer with offer_set_at), recorded while the business profile said exactly what it says
// now (the same seller snapshot). The next run of that play reuses it, so a London CRM request run again beside a saved
// dental profile keeps the CRM offer instead of asking again or falling back to dental. A changed profile, another
// request or another tenant never matches: the run then resolves its offer as a new play does (and is refused on a
// conflict). null: nothing confirmed.
const CONFIRMED_SQL = "SELECT offer, seller FROM scan_jobs WHERE user_id = ? AND query = ? AND offer IS NOT NULL AND offer_set_at IS NOT NULL AND COALESCE(seller, '') = ? ORDER BY offer_set_at DESC, created_at DESC, insert_seq DESC LIMIT 1"
export async function confirmedPlayOffer(db: DbLike, tenantId: string, query: string, sellerLine: string): Promise<{ offer: string; seller: string | null } | null> {
  if (typeof query !== 'string' || query.trim().length < 3) return null
  let row: { offer: string | null; seller: string | null } | undefined
  try { row = await asDb(db).get<{ offer: string | null; seller: string | null }>(CONFIRMED_SQL, [tenantId, query.trim(), (sellerLine ?? '').trim().slice(0, 300)]) } catch (e) { if (isMissingSchema(e)) return null; throw e }
  const offer = cleanOffer(row?.offer)
  return row && offer.length >= 3 ? { offer, seller: row.seller } : null
}
// The same, for a scheduled run of a saved play (weekly watch, monitor), which has no request body: matched against the
// tenant's business profile as it is now (the seller snapshot POST /api/scan records). When nothing is confirmed (offer
// null) the run records that snapshot too, as a manual run does, so its play has a recorded offer instead of waiting for
// a choice every week (#687) - but only when the profile states an offer: a website alone is not one, so such a run (and
// a Memory-only tenant's) keeps seller null and stays unconfirmed until the tenant chooses, never pinned to a domain.
export async function scheduledPlayOffer(db: Db, tenantId: string, query: string): Promise<{ offer: string | null; seller: string | null }> {
  let line = '', sells = ''
  try { line = await readSellerLine(db, tenantId); sells = (await readSellerProfile(db, tenantId)).sells } catch (e) { if (!isMissingSchema(e)) throw e /* else: no profile table */ }
  return (await confirmedPlayOffer(db, tenantId, query, line)) ?? { offer: null, seller: sells.trim() ? line.trim() || null : null }
}

// Sets the offer of one play of this tenant, and nothing else: the profile and every other play keep theirs.
export async function setPlayOffer(db: Db, tenantId: string, jobId: string, offer: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const o = cleanOffer(offer)
  if (o.length < 3) return false
  return (await db.run('UPDATE scan_jobs SET offer = ?, offer_set_at = ? WHERE id = ? AND user_id = ?', [o, now, jobId, tenantId])).changes === 1
}
