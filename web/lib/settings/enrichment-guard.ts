// Per-tenant rate limit for enrichment credential writes (Apollo/PDL key save/disconnect).
// The bucket key carries the tenant id so one tenant - or anonymous traffic, which the
// route rejects before calling this - cannot exhaust another tenant's allowance.
// A shared global bucket here was finding F2 in docs/security/tenant-isolation-assessment.md.
import { rateLimit } from '../rate-limit.ts'

export function enrichmentWriteLimit(userId: string): { ok: boolean; retryAfterS: number } {
  return rateLimit(`settings:enrichment:${userId}`, 20, 60_000)
}
