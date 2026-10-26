// Owner direction (#204): when the user's own time window excluded results, say so and offer to change it explicitly -
// never relax it quietly. Pure, so the page and its tests use one rule.
// Counts come from the event dates themselves (windowStatus), not from review_reason: an ordinary source review clears
// review_reason but never the window hold (#198, outreach/currentness.ts), so a reviewed lead still counts here.
// Quarantined leads are left out: they are excluded for another reason. Nothing here starts a scan: the action only
// fills the profile editor, and a scan runs only when the user presses run there.
import { windowStatus, MAX_WINDOW_DAYS } from './window.ts'

export interface NoticeLead { event_date: string | null; quarantined_at?: number | null }
export interface WindowNotice { older: number; noDate: number; text: string; editTo: number | null; editLabel: string | null; editNote: string | null }

export function windowNotice(leads: NoticeLead[], windowDays: number | null | undefined, now: Date = new Date()): WindowNotice | null {
  if (!windowDays) return null
  let older = 0; let noDate = 0
  for (const l of leads) {
    if (l.quarantined_at) continue
    const s = windowStatus(l.event_date, windowDays, now)
    if (s === 'stale') older++
    else if (s !== 'inside') noDate++
  }
  if (older + noDate === 0) return null
  const parts: string[] = []
  if (older) parts.push(`${older} ${older === 1 ? 'result is' : 'results are'} older than your ${windowDays}-day window`)
  if (noDate) parts.push(`${noDate} ${noDate === 1 ? 'has' : 'have'} no usable date (missing, invalid or in the future)`)
  const text = `${parts.join(' and ')}. ${older + noDate === 1 ? 'It is' : 'They are'} kept as research only: not drafted or sent, even after you review the source.`
  // Only an older-than-window result can come back by widening; an undated one never will.
  const wider = Math.min(MAX_WINDOW_DAYS, windowDays * 2)
  const editTo = older && wider > windowDays ? wider : null
  return {
    older, noDate, text, editTo,
    editLabel: editTo ? `Edit window to ${editTo} days` : null,
    editNote: editTo ? `Window set to ${editTo} days in the profile below. Nothing runs until you press run; a new scan uses your usual scan budget.` : null,
  }
}
