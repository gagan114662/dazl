// Discovery can display a date from the search index, but only an event date can
// make a lead ready. Older discovery rows may have no stored date status.
export function hasDiscoveryEventDate(lead: { event_date?: string | null; date_status?: string | null }): boolean {
  return !!lead.event_date && lead.date_status !== 'unverified'
}
