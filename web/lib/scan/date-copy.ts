// Legacy verified labels came from nearby dates, not event association proof.
// Preserve the stored claim, never promote it to an established occurrence.
export function eventDateCopy(eventDate: string | null, _status: string | null, timing?: 'proof_backed' | 'unconfirmed' | null, opts: { dayVerified?: boolean; windowMissed?: boolean } = {}): string {
  if (!eventDate) return 'event date unknown - current need not confirmed'
  // Proof-backed (page_bound / ats_structured): the association IS what the proof establishes, so the line stops
  // saying "claimed / association unconfirmed" (#498 whole-card coherence). Current need stays unconfirmed either way.
  if (timing === 'proof_backed') return `${eventDate} (event day verified on the cited source; current need unconfirmed)`
  // Event day proven but the requested window missed: the association is still what the proof establishes and the
  // window verdict is KNOWN (outside), never "unresolved" and never "claimed" beside proven event-day evidence.
  if (opts.dayVerified && opts.windowMissed) return `${eventDate} (event day verified on the cited source; outside the requested recency window - current need unconfirmed)`
  // Event day proven but the run's requested recency window unresolved: only the window and current need stay open.
  if (opts.dayVerified) return `${eventDate} (event day verified on the cited source; requested recency window unresolved - current need unconfirmed)`
  return `${eventDate} (claimed event day; event association and current need unconfirmed)`
}

// A lead card's event-date line (app/app/leads/leads-client.tsx), from the lead as the leads route returns it: the proof
// verdict (day_verified, eventDayVerified), the timing verdict and the run's window, never date_status (#1176). Every date
// line on the card reads through this, so the card cannot say "verified" in one place and "claimed" in another.
export const leadCardDateLine = (l: { event_date: string | null; date_status: string | null; timing?: 'proof_backed' | 'unconfirmed' | null; day_verified?: boolean; window_missed?: boolean }): string =>
  eventDateCopy(l.event_date, l.date_status, l.timing, { dayVerified: l.day_verified, windowMissed: l.window_missed })
