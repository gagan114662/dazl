// Legacy verified labels came from nearby dates, not event association proof.
// Preserve the stored claim, never promote it to an established occurrence.
export function eventDateCopy(eventDate: string | null, _status: string | null, timing?: 'proof_backed' | 'unconfirmed' | null, dayVerified?: boolean): string {
  if (!eventDate) return 'event date unknown - current need not confirmed'
  // Proof-backed (page_bound / ats_structured): the association IS what the proof establishes, so the line stops
  // saying "claimed / association unconfirmed" (#498 whole-card coherence). Current need stays unconfirmed either way.
  if (timing === 'proof_backed') return `${eventDate} (event day verified on the cited source; current need unconfirmed)`
  // Event day proven but the run's requested recency window unresolved (or missed): the association is still what the
  // proof establishes - only the window and current need stay open. Never "claimed" beside proven event-day evidence.
  if (dayVerified) return `${eventDate} (event day verified on the cited source; requested recency window unresolved - current need unconfirmed)`
  return `${eventDate} (claimed event day; event association and current need unconfirmed)`
}
