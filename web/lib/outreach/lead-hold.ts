// The one place that says why a lead is held (or ready) the way Home's "Ready leads" tile and the Leads page do: the hold fields
// exactly as GET /api/leads computes them for this lead (gate verdict, time-window and currentness holds, timing-adjusted intent,
// its enrichments), then lib/journey.ts heldReason. Relative imports only, so scripts (web/scripts/matrix-local.mts) can use it.
import type Database from 'better-sqlite3'
import { currentnessHeld, leadWindowHeld } from './currentness.ts'
import { requiredGateHeld } from '../scan/held-state.ts'
import { eventDayVerified, surfaceStoredIntent, TIMING_REQUESTED } from '../scan/scoreboard.ts'
import { jobWindowDays } from '../scan/window.ts'
import { heldReason, type PreviewLead } from '../journey.ts'

export interface TimingOpts { windowDays: number | null; timingRequired: boolean }
export const timingOptsFor = (job: { query: string | null; icp: string | null }): TimingOpts => {
  const windowDays = jobWindowDays(job as never)
  return { windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(job.query ?? '') }
}

// null = ready; otherwise the first failing check's own words.
export function leadHoldReason(db: Database.Database, tenantId: string, lead: Record<string, unknown> & { id: string }, enrichments: unknown[], timing: TimingOpts, at: Date): string | null {
  let candidates: { address: string; verification: string }[] = []
  try { candidates = db.prepare('SELECT address, verification FROM email_candidates WHERE tenant_id = ? AND lead_id = ?').all(tenantId, lead.id) as typeof candidates }
  catch (e) { if (!/no such (?:table|column)/i.test(String((e as Error)?.message))) throw e }
  const row = { ...lead, email_candidates: candidates, stored_intent: lead.intent ?? null, intent: surfaceStoredIntent(lead as never, timing).intent, enrichments, day_verified: eventDayVerified(lead as never, { now: at }),   // #1176: a proven day counts
    window_held: leadWindowHeld(db, tenantId, lead.id, at), currentness_held: currentnessHeld(db, tenantId, lead.id, at), gate_held: requiredGateHeld(db, tenantId, lead.id) !== null }
  return heldReason(row as unknown as PreviewLead)
}
