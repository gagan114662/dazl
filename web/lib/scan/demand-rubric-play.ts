// The demand rubric of one play (#401), read from what the tenant configured for every customer the same way: the play's
// effective offer (play-offer.ts, including its conflict refusal) and the tenant's saved competitors (Settings). Tenant
// scoped: another tenant's play id resolves to no rubric. No seller-specific input exists.
import type { Db } from '../db/client.ts'
import { readPlayOffer } from './play-offer.ts'
import { readCompetitors } from '../signals/competitor-reddit.ts'
import { rubricForPlay, type DemandRubric } from './demand-qualifier.ts'

export async function loadPlayDemandRubric(db: Db, tenantId: string, jobId: string, windowDays?: number): Promise<{ rubric: DemandRubric | null; reason: string | null }> {
  const offer = await readPlayOffer(db, tenantId, jobId)
  if (!offer) return rubricForPlay(null, [])
  return rubricForPlay(offer, await readCompetitors(db, tenantId), [], windowDays)
}
