// Shared by the server (lib/calcom setManualOutcome) and the settings panel (app/app/settings/calcom-panel.tsx), so the
// panel offers exactly the reconciliations the server accepts. Pure: no database, no Node-only imports.

export type BookingStatus = 'scheduled' | 'ended' | 'held' | 'no_show' | 'cancelled' | 'rescheduled'
export type ReconcileAction = 'held' | 'no_show' | 'cancelled' | 'clear'

// A meeting is over once its scheduled end has passed (end_at <= now) or Cal.com sent MEETING_ENDED (ended_at set).
// Its start passing is not enough: a 60-minute meeting one minute in has not happened yet. With neither known (no end
// time and no MEETING_ENDED) it is not over: held / no-show claims fail closed. Times are epoch seconds.
export function meetingOver(b: { end_at: number | null; ended_at: number | null }, nowS: number): boolean {
  return (b.end_at !== null && b.end_at <= nowS) || b.ended_at !== null
}

// The reconciliation controls a member sees for one booking. Only a member who may configure the workspace
// (can(role, 'configure'), the POST route's gate) gets any; a booking rescheduled away is not the meeting any more;
// held / no-show only once the meeting is over.
export function reconcileActions(b: { status: BookingStatus; end_at: number | null; ended_at: number | null; manual_outcome: string | null }, canConfigure: boolean, nowS: number): ReconcileAction[] {
  if (!canConfigure || b.status === 'rescheduled') return []
  const out: ReconcileAction[] = []
  const over = meetingOver(b, nowS)
  if (over && b.status !== 'held') out.push('held')
  if (over && b.status !== 'no_show') out.push('no_show')
  if (b.status !== 'cancelled') out.push('cancelled')
  if (b.manual_outcome) out.push('clear')
  return out
}
