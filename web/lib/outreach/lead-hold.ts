// The one place that says why a lead is held (or ready) the way Home's "Ready leads" tile and the Leads page do: the hold fields
// exactly as GET /api/leads computes them for this lead (gate verdict, time-window and currentness holds, timing-adjusted intent,
// its enrichments), then lib/journey.ts heldReason. Relative imports only, so scripts (web/scripts/matrix-local.mts) can use it.
import type Database from 'better-sqlite3'
import { currentnessHeld, leadWindowHeld } from './currentness.ts'
import { requiredGateHeld } from '../scan/held-state.ts'
import { eventDayVerified, surfaceStoredIntent, TIMING_REQUESTED } from '../scan/scoreboard.ts'
import { jobWindowDays } from '../scan/window.ts'
import { heldReason, type PreviewLead } from '../journey.ts'
import { isDiscoverLead } from '../discover/card.ts'

export interface TimingOpts { windowDays: number | null; timingRequired: boolean }
export const timingOptsFor = (job: { query: string | null; icp: string | null; run_budget?: string | null }): TimingOpts => {
  const windowDays = jobWindowDays(job as never)
  return { windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(job.query ?? '') }
}

// null = ready; otherwise the first failing check's own words.
export function leadHoldReason(db: Database.Database, tenantId: string, lead: Record<string, unknown> & { id: string }, enrichments: unknown[], timing: TimingOpts, at: Date): string | null {
  const surfaced = surfaceStoredIntent(lead as never, timing)
  const row = { ...lead, stored_intent: lead.intent ?? null, intent: surfaced.intent, enrichments, day_verified: eventDayVerified(lead as never, { now: at }),   // #1176: a proven day counts
    window_held: leadWindowHeld(db, tenantId, lead.id, at), currentness_held: currentnessHeld(db, tenantId, lead.id, at), gate_held: requiredGateHeld(db, tenantId, lead.id) !== null }
  const why = heldReason(row as unknown as PreviewLead)
  if (why) return why
  // #1831: the Leads page's Research rule (#1735) — a lead whose timing the route surfaces as unconfirmed, with no
  // review reason and no human confirmation, is Research only there, so Home and the header must not count it ready.
  // heldReason never reads that verdict: it surfaces intent 0 for an unconfirmed lead and passes, so a lead with no
  // saved grade (intent null) whose durable timing proof otherwise stands counted as ready here while the Leads page
  // showed it under Research. Held in heldReason's own currentness words. Discovery-lane leads are exempt: they have
  // one state (discoverNotReady, above), the state their card, the header counts and Home already agree on (#1238).
  if (!isDiscoverLead(lead as { source_kind?: string | null }) && surfaced.timing === 'unconfirmed' && !lead.review_reason && lead.human_confirmed_at == null) return 'event timing unknown'
  return null
}
