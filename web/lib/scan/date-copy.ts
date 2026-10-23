// Event date is distinct from scan/retrieval time. Even a date found on a page
// does not establish that the company still has this need today.
export function eventDateCopy(eventDate: string | null, status: string | null): string {
  if (!eventDate) return 'event date unknown - current need not confirmed'
  if (status !== 'verified') return `${eventDate} (date not confirmed on page; current need not confirmed)`
  return `${eventDate} (date found on page; current need not confirmed)`
}
