import type { DbLike } from '../db/client.ts'
import { apolloPersonMatch, type ApolloMatch } from './apollo.ts'
import { reserveApolloLead } from './apollo-credit-ledger.ts'

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
  options: { key: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<ApolloMatch | null> {
  const first = evidence.first.trim()
  const last = evidence.last.trim()
  const domain = evidence.confirmedDomain.trim()
  const key = options.key.trim()
  if (!key || !first || !last || !domain || !evidence.dayVerified || !evidence.otherwiseReady ||
    evidence.ownSiteRead !== 'none_published') return null
  if (!await reserveApolloLead(db, tenantId, leadId, options.env)) return null
  return apolloPersonMatch(key, { first, last, domain }, options.fetchImpl)
}
