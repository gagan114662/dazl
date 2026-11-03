// The demand rubric of one play (#401), read from what the tenant configured for every customer the same way: the play's
// effective offer (play-offer.ts, including its conflict refusal) and the tenant's saved competitors (Settings). Tenant
// scoped: another tenant's play id resolves to no rubric. The seller's own names come from the tenant's configured
// identity (business name, website brand) - every tenant has them, no seller-specific branch - so a post by the seller's
// own people is excluded as own_seller instead of reaching high_intent (#401 blocker: own_names was hardcoded []).
import type { Db } from '../db/client.ts'
import { readPlayOffer } from './play-offer.ts'
import { readCompetitors } from '../signals/competitor-reddit.ts'
import { rubricForPlay, type DemandRubric } from './demand-qualifier.ts'

// Generic labels that would exclude real buyers if treated as a brand ("Sales", "Group"): never an own name on their own.
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
      const label = parts.length >= 2 ? parts[parts.length - (parts[parts.length - 2].length <= 3 && parts.length >= 3 && parts[parts.length - 1].length === 2 ? 3 : 2)] : ''
      if (label.length >= 3 && !GENERIC.has(label)) out.add(label)
    } catch { /* unparseable website: the business name still applies */ }
  }
  return [...out]
}

export async function loadPlayDemandRubric(db: Db, tenantId: string, jobId: string, windowDays?: number): Promise<{ rubric: DemandRubric | null; reason: string | null }> {
  const offer = await readPlayOffer(db, tenantId, jobId)
  if (!offer) return rubricForPlay(null, [])
  const me = await db.get<{ business_name: string | null; website: string | null }>('SELECT business_name, website FROM users WHERE id = ?', [tenantId])
  return rubricForPlay(offer, await readCompetitors(db, tenantId), ownNamesFrom(me?.business_name, me?.website), windowDays)
}
