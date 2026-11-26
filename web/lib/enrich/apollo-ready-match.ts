import type { DbLike } from '../db/client.ts'
import { apolloPersonMatch, type ApolloMatch } from './apollo.ts'
import { recordApolloResult, reserveApolloLead } from './apollo-credit-ledger.ts'

export interface ApolloBuyerEvidence {
  first: string
  last: string
  confirmedDomain: string
  dayVerified: boolean
  otherwiseReady: boolean
  ownSiteRead: 'incomplete' | 'none_published' | 'address_found'
}

/** The scan must supply its current Ready verdict and completed crawl outcome. */
export async function matchReadyApolloBuyer(
  db: DbLike,
  tenantId: string,
  leadId: string,
  evidence: ApolloBuyerEvidence,
  options: { key: string; scanId: string; scanLimit: number; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<ApolloMatch | null> {
  const first = evidence.first.trim()
  const last = evidence.last.trim()
  const domain = evidence.confirmedDomain.trim()
  const key = options.key.trim()
  if (!key || !first || !last || !domain || !evidence.dayVerified || !evidence.otherwiseReady ||
    evidence.ownSiteRead !== 'none_published') return null
  if (!await reserveApolloLead(db, tenantId, leadId, options.env, { id: options.scanId, limit: options.scanLimit })) return null
  let match: ApolloMatch | null
  try {
    match = await apolloPersonMatch(key, { first, last, domain }, options.fetchImpl)
  } catch (error) {
    await recordApolloResult(db, tenantId, leadId, 'uncertain').catch(() => {
      // The durable reservation still accounts for this credit.
    })
    throw error
  }
  await recordApolloResult(db, tenantId, leadId, match ? 'matched' : 'empty')
  return match
}
