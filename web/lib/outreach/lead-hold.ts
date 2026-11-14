// The one place that says why a lead is held (or ready) the way Home's "Ready leads" tile and the Leads page do: the hold fields
// exactly as GET /api/leads computes them for this lead (gate verdict, time-window and currentness holds, timing-adjusted intent,
// its enrichments), then lib/journey.ts heldReason. Relative imports only, so scripts (web/scripts/matrix-local.mts) can use it.
import type Database from 'better-sqlite3'
import { currentnessHeld, leadWindowHeld } from './currentness.ts'
import { requiredGateHeld } from '../scan/held-state.ts'
import { surfaceStoredIntent, TIMING_REQUESTED } from '../scan/scoreboard.ts'
import { jobWindowDays } from '../scan/window.ts'
import { heldReason, type PreviewLead } from '../journey.ts'

export interface TimingOpts { windowDays: number | null; timingRequired: boolean }
export const timingOptsFor = (job: { query: string | null; icp: string | null }): TimingOpts => {
  const windowDays = jobWindowDays(job as never)
  return { windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(job.query ?? '') }
}

// null = ready; otherwise the first failing check's own words.
export function leadHoldReason(db: Database.Database, tenantId: string, lead: Record<string, unknown> & { id: string }, enrichments: unknown[], timing: TimingOpts, at: Date): string | null {
  const row = { ...lead, intent: surfaceStoredIntent(lead as never, timing).intent, enrichments,
    window_held: leadWindowHeld(db, tenantId, lead.id, at), currentness_held: currentnessHeld(db, tenantId, lead.id, at), gate_held: requiredGateHeld(db, tenantId, lead.id) !== null }
  return heldReason(row as unknown as PreviewLead)
}
