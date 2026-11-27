import { createHash } from 'node:crypto'
import { reviewWithDigest } from './domain-review-view.ts'

export { REVIEW_PREFIX } from './domain-review-view.ts'
export type { Covered, ReviewDecision, ReviewState } from './domain-review-view.ts'

export function domainReviewFor(lead: Parameters<typeof reviewWithDigest>[0], enrichments: Parameters<typeof reviewWithDigest>[1]) {
  return reviewWithDigest(lead, enrichments, value => createHash('sha256').update(value).digest('hex'))
}
