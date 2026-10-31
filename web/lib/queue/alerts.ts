// Queue alerts (#355): pure rules over DbQueue.stats(). A lane whose oldest claimable item has waited too long, dead
// letters piling up, or claims whose worker died (expired leases nobody reaped). Counts and kinds only, never tenant
// data, so the result can go to the health endpoint and the error log as is.
import type { QueueKindStats } from './types.ts'

export interface QueueThresholds { maxWaitS: Record<string, number>; defaultMaxWaitS: number; maxFailed: number; maxExpired: number }
// Reply checks and suppression are time-sensitive (an opt-out by email is found by the reply check), so their waits are
// short; research can wait longer.
export const DEFAULT_THRESHOLDS: QueueThresholds = {
  maxWaitS: { 'reply-check': 15 * 60, suppression: 5 * 60, followup: 30 * 60, sequence: 30 * 60 },
  defaultMaxWaitS: 60 * 60, maxFailed: 20, maxExpired: 0,
}
export interface QueueAlert { kind: string; alert: 'queue_age' | 'dead_letters' | 'expired_claims'; value: number; limit: number }

export function queueAlerts(stats: QueueKindStats[], th: QueueThresholds = DEFAULT_THRESHOLDS): QueueAlert[] {
  const out: QueueAlert[] = []
  for (const s of stats) {
    const wait = th.maxWaitS[s.kind] ?? th.defaultMaxWaitS
    if (s.oldestPendingAgeS > wait) out.push({ kind: s.kind, alert: 'queue_age', value: s.oldestPendingAgeS, limit: wait })
    if (s.failed > th.maxFailed) out.push({ kind: s.kind, alert: 'dead_letters', value: s.failed, limit: th.maxFailed })
    if (s.expiredClaims > th.maxExpired) out.push({ kind: s.kind, alert: 'expired_claims', value: s.expiredClaims, limit: th.maxExpired })
  }
  return out
}
