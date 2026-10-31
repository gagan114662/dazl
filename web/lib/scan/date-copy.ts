// Legacy verified labels came from nearby dates, not event association proof.
// Preserve the stored claim, never promote it to an established occurrence.
export function eventDateCopy(eventDate: string | null, _status: string | null, timing?: 'proof_backed' | 'unconfirmed' | null): string {
  if (!eventDate) return 'event date unknown - current need not confirmed'
  // Proof-backed (page_bound / ats_structured): the association IS what the proof establishes, so the line stops
  // saying "claimed / association unconfirmed" (#498 whole-card coherence). Current need stays unconfirmed either way.
  if (timing === 'proof_backed') return `${eventDate} (event day verified on the cited source; current need unconfirmed)`
  return `${eventDate} (claimed event day; event association and current need unconfirmed)`
}
