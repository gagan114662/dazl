// The discovery writer records index provenance in timing_note. date_status alone
// also covers structured postings and legacy dates, so it cannot identify index dates.
const INDEX_DATE_NOTE = 'The page prints no date. This is the day the search index dates the page.'

export function hasDiscoveryEventDate(lead: { event_date?: string | null; timing_note?: string | null }): boolean {
  return !!lead.event_date && lead.timing_note !== INDEX_DATE_NOTE
}
