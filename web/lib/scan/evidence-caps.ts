// Scores follow evidence. fit / intent / action are graded once, at scan time, from the evidence the model saw. When the evidence
// later turns out blocked, stale, wrong-company or quarantined, the stored grade must not keep presenting the lead as highly actionable.
// This is a read-time ceiling, recomputed from the lead's CURRENT evidence state on every read: it only ever lowers a score, never
// raises one, never rewrites history, and records why (score_caps) so the UI and CSV can say so.
export interface CapInput {
  fit?: number | null; intent?: number | null; action?: number | null
  review_reason?: string | null; quarantined_at?: number | null; event_date?: string | null; date_status?: string | null
}
type Cap = { fit?: number; intent?: number; action?: number; why: string }
const BLOCKED = ['blocked_by_site', 'needs_javascript', 'login_required', 'quote_unconfirmed', 'source_review_required', 'counterparty_signal', 'self_description']
const STALE = ['outside_window', 'event_date_stale', 'event_date_future_date', 'event_date_bad_date', 'job_closed']
const STALE_DAYS = 180
export function capsFor(l: CapInput, now = Date.now()): Cap[] {
  const caps: Cap[] = []
  if (l.quarantined_at) caps.push({ fit: 2, intent: 1, action: 0, why: 'quarantined' })
  const r = l.review_reason ?? ''
  if (r === 'location_mismatch') caps.push({ fit: 2, intent: 1, action: 0, why: 'source names a different place (possible same-name business)' })
  else if (r === 'location_unconfirmed') caps.push({ fit: 3, intent: 2, action: 1, why: 'source does not name the requested place' })
  else if (BLOCKED.includes(r)) caps.push({ intent: 2, action: 1, why: `not verified (${r})` })
  else if (STALE.includes(r)) caps.push({ intent: 1, action: 1, why: `evidence outside the window or closed (${r})` })
  else if (r === 'outside_window_undated' || r === 'event_timing_unconfirmed') caps.push({ intent: 2, action: 2, why: 'timing unconfirmed' })
  const t = l.event_date ? Date.parse(l.event_date) : NaN
  if (Number.isFinite(t)) {
    const age = (now - t) / 86_400_000
    if (age > STALE_DAYS) caps.push({ intent: 1, action: 1, why: `evidence is ${Math.floor(age)} days old` })
    else if (age < -1) caps.push({ intent: 1, action: 1, why: 'event date is in the future' })
  } else if (!r && !l.quarantined_at) caps.push({ action: 3, why: 'no event date' })
  return caps
}
export function capScores<T extends CapInput>(l: T, now = Date.now()): T & { score_caps: string[]; stored_fit: number | null; stored_action: number | null } {
  const caps = capsFor(l, now)
  const lower = (v: number | null | undefined, ceilings: (number | undefined)[]) => v === null || v === undefined ? v ?? null : Math.min(v, ...ceilings.filter((c): c is number => c !== undefined))
  return { ...l, stored_fit: l.fit ?? null, stored_action: l.action ?? null,
    fit: lower(l.fit, caps.map(c => c.fit)), intent: lower(l.intent, caps.map(c => c.intent)), action: lower(l.action, caps.map(c => c.action)),
    score_caps: [...new Set(caps.map(c => c.why))] }
}
