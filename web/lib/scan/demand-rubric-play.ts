// The demand rubric of one play (#401), read from what the tenant configured for every customer the same way: the play's
// effective offer (play-offer.ts, including its conflict refusal) and the tenant's saved competitors (Settings). Tenant
// scoped: another tenant's play id resolves to no rubric. The seller's own names come from the tenant's configured
// identity (business name, website brand) - every tenant has them, no seller-specific branch - so a post by the seller's
// own people is excluded as own_seller instead of reaching high_intent (#401 blocker: own_names was hardcoded []).
import type { Db } from '../db/client.ts'
import { readPlayOffer } from './play-offer.ts'
import { readCompetitorsStrict } from '../signals/competitor-reddit.ts'
import { rubricForPlay, type DemandRubric } from './demand-qualifier.ts'

// Generic labels that would exclude real buyers if treated as a brand ("Sales", "Group"): never an own name on their own.
// Second-level labels that sit under a two-letter country code (bbc.co.uk, shop.mysite.com.au), not brand names.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'nom', 'mil'])
const GENERIC = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'company', 'group', 'the', 'sales', 'labs', 'app', 'web', 'shop', 'online'])

// The seller's own brand names: the business name as typed, and the website's registrable label ("acme.io" -> "acme").
export function ownNamesFrom(businessName: string | null | undefined, website: string | null | undefined): string[] {
  const out = new Set<string>()
  const bn = (businessName ?? '').trim()
  if (bn.length >= 3 && !GENERIC.has(bn.toLowerCase())) out.add(bn)
  const raw = (website ?? '').trim()
  if (raw) {
    try {
      const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
      const parts = host.split('.')
      // Registrable label: one label left of the suffix. Only a real second-level suffix (co.uk, com.au) moves it one more;
      // a short ordinary label (app.acm.io, app.foo.ai) is a name or subdomain, never a suffix (#401 review).
      const sld = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2])
      const label = parts.length >= 2 ? parts[parts.length - (sld ? 3 : 2)] : ''
      if (label.length >= 3 && !GENERIC.has(label)) out.add(label)
    } catch { /* unparseable website: the business name still applies */ }
  }
  return [...out]
}

export async function loadPlayDemandRubric(db: Db, tenantId: string, jobId: string, windowDays?: number): Promise<{ rubric: DemandRubric | null; reason: string | null }> {
  const offer = await readPlayOffer(db, tenantId, jobId)
  if (!offer) return rubricForPlay(null, [])
  // Exclusion state is fail-closed: an UNREADABLE competitors list or seller identity means the exclusions cannot be
  // known, so the play has NO rubric and every lead holds - never an empty exclusion list that lets an excluded
  // vendor or the seller's own post promote (#401 review).
  let me: { business_name: string | null; website: string | null } | undefined
  try { me = await db.get<{ business_name: string | null; website: string | null }>('SELECT business_name, website FROM users WHERE id = ?', [tenantId]) }
  catch (e) { if (e instanceof Error && /no such table|does not exist/i.test(e.message)) return { rubric: null, reason: 'identity_unreadable' }; throw e }
  const competitors = await readCompetitorsStrict(db, tenantId)
  if (competitors === null) return { rubric: null, reason: 'competitors_unreadable' }
  return rubricForPlay(offer, competitors, ownNamesFrom(me?.business_name, me?.website), windowDays)
}
