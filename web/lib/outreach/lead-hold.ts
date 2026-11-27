// The one place that says why a lead is held (or ready) the way Home's "Ready leads" tile and the Leads page do: the hold fields
// exactly as GET /api/leads computes them for this lead (gate verdict, time-window and currentness holds, timing-adjusted intent,
// its enrichments), then lib/journey.ts heldReason. Relative imports only, so scripts (web/scripts/matrix-local.mts) can use it.
import type Database from 'better-sqlite3'
import { currentnessHeld, leadWindowHeld } from './currentness.ts'
import { requiredGateHeld } from '../scan/held-state.ts'
import { eventDayVerified, surfaceStoredIntent, TIMING_REQUESTED } from '../scan/scoreboard.ts'
import { jobWindowDays } from '../scan/window.ts'
import { heldReason, publishedAddressRefused, type PreviewLead } from '../journey.ts'
import { isUnconfirmedTimingResearch } from '../lead-state.ts'
import { discoverRecipientRefusal } from './service.ts'

export interface TimingOpts { windowDays: number | null; timingRequired: boolean }
export const timingOptsFor = (job: Parameters<typeof jobWindowDays>[0]): TimingOpts => {
  const windowDays = jobWindowDays(job)
  return { windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(job.query ?? '') }
}

// Candidate checks are mailbox facts only. They do not become published contacts.
export function legacyMailboxRefusals(
  db: Database.Database, tenantId: string, leads: readonly { id: string }[],
  enrichments: Record<string, PreviewLead['enrichments']>,
): Set<string> {
  const legacy = (leads as readonly (PreviewLead & { source_kind?: string | null })[])
    .filter(lead => lead.source_kind !== 'discover')
  if (!legacy.length) return new Set()

  let candidates: { lead_id: string; address: string; verification: string; checked_at: number }[] = []
  try {
    candidates = db.prepare(`SELECT lead_id, address, verification, checked_at FROM email_candidates
      WHERE tenant_id = ? AND lead_id IN (${legacy.map(() => '?').join(',')})
      AND verification IN ('undeliverable', 'verified') AND checked_at IS NOT NULL`)
      .all(tenantId, ...legacy.map(lead => lead.id)) as typeof candidates
  } catch (error) {
    // Older stores have no candidate verifier history. Their enrichment checks still apply.
    if (!(error instanceof Error) || !/^no such (?:table: email_candidates|column: (?:verification|checked_at))$/.test(error.message)) throw error
  }
  const checks: Record<string, NonNullable<PreviewLead['enrichments']>> = {}
  for (const row of candidates) {
    const verdict = row.verification === 'undeliverable' ? 'rejected' : 'accepted'
    ;(checks[row.lead_id] ??= []).push({ connector: 'mailbox-check', kind: 'deliverability',
      value: `${row.address}|${verdict}`, label: null, source_url: '', retrieved_at: row.checked_at })
  }
  return new Set(legacy.filter(lead => publishedAddressRefused({
    ...lead, enrichments: [...(enrichments[lead.id] ?? []), ...(checks[lead.id] ?? [])],
  })).map(lead => lead.id))
}

// null = ready; otherwise the first failing check's own words.
export function leadHoldReason(db: Database.Database, tenantId: string, lead: Record<string, unknown> & { id: string }, enrichments: unknown[], timing: TimingOpts, at: Date): string | null {
  const surfaced = surfaceStoredIntent(lead as never, timing)
  const recipientRefused = lead.source_kind === 'discover' ? discoverRecipientRefusal(db, tenantId, lead.id) : null
  const row = { ...lead, recipient_refused: recipientRefused, stored_intent: lead.intent ?? null, ...surfaced, enrichments, day_verified: eventDayVerified(lead as never, { now: at }),   // #1176: a proven day counts
    window_held: leadWindowHeld(db, tenantId, lead.id, at), currentness_held: currentnessHeld(db, tenantId, lead.id, at), gate_held: requiredGateHeld(db, tenantId, lead.id) !== null }
  const preview = row as unknown as PreviewLead
  if (lead.source_kind !== 'discover') preview.email_cannot_receive_mail = legacyMailboxRefusals(db, tenantId, [preview], { [lead.id]: preview.enrichments }).has(lead.id)
  return heldReason(preview) ?? (isUnconfirmedTimingResearch({ ...preview, timing: surfaced.timing }) ? 'event timing unknown' : null)
}
