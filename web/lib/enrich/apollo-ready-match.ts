import type { DbLike } from '../db/client.ts'
import { apolloPersonMatch, type ApolloMatch } from './apollo.ts'
import { planApolloReservations, recordApolloResult, reserveApolloLead } from './apollo-credit-ledger.ts'

export interface ApolloBuyerEvidence {
  first: string
  last: string
  confirmedDomain: string
  dayVerified: boolean
  otherwiseReady: boolean
  ownSiteRead: 'incomplete' | 'none_published' | 'address_found'
}

function buyerQuery(evidence: ApolloBuyerEvidence): { first: string; last: string; domain: string } | null {
  const first = evidence.first.trim()
  const last = evidence.last.trim()
  const domain = evidence.confirmedDomain.trim()
  return first && last && domain && evidence.dayVerified && evidence.otherwiseReady &&
    evidence.ownSiteRead === 'none_published' ? { first, last, domain } : null
}

export function planApolloBuyerMatches(
  db: DbLike,
  tenantId: string,
  candidates: readonly { leadId: string; evidence: ApolloBuyerEvidence }[],
  scan: { id: string; limit: number },
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const eligibleIds = candidates.filter(candidate => buyerQuery(candidate.evidence)).map(candidate => candidate.leadId)
  return planApolloReservations(db, tenantId, eligibleIds, env, scan)
}

/** The scan must supply its current Ready verdict and completed crawl outcome. */
export async function matchReadyApolloBuyer(
  db: DbLike,
  tenantId: string,
  leadId: string,
  evidence: ApolloBuyerEvidence,
  options: { key: string; scanId: string; scanLimit: number; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<ApolloMatch | null> {
  const query = buyerQuery(evidence)
  const key = options.key.trim()
  if (!key || !query) return null
  if (!await reserveApolloLead(db, tenantId, leadId, options.env, { id: options.scanId, limit: options.scanLimit })) return null
  let match: ApolloMatch | null
  try {
    const dispatch = options.fetchImpl ?? fetch
    match = await apolloPersonMatch(key, query, (input, init) => dispatch(input, { ...init, redirect: 'error' }))
  } catch (error) {
    await recordApolloResult(db, tenantId, leadId, 'uncertain').catch(() => {
      // The durable reservation still accounts for this credit.
    })
    throw error
  }
  await recordApolloResult(db, tenantId, leadId, match ? 'matched' : 'empty')
  return match
}
