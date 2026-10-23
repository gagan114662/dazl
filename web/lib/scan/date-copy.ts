// Legacy verified labels came from nearby dates, not event association proof.
// Preserve the stored claim, never promote it to an established occurrence.
export function eventDateCopy(eventDate: string | null, _status: string | null): string {
  if (!eventDate) return 'event date unknown - current need not confirmed'
  return `${eventDate} (claimed event day; event association and current need unconfirmed)`
}
