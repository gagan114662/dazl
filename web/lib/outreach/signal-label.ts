// Browser-safe: the signal-type labels Home shows (moved out of lib/outreach/home-results.ts, which is server-only).
// The signal ids (lib/scan/score.ts SIGNALS, plus commenter imports' competitor_complaint) in plain words.
// A source row holds only that channel's leads with no graded type (a graded lead counts under its type), so each label says so.
const SOURCE_LABEL: Record<string, string> = {
  query: 'Search', hiring_feed: 'Hiring feed', csv: 'CSV import', manual_source: 'Added by you',
  watch: 'Watched search', monitor: 'Monitor', commenter: 'Commenters on a post', first_party: 'Your site visitors',
}
export function signalLabel(id: string): string {
  if (id === 'unknown') return 'No signal type'
  if (id.startsWith('source:')) { const s = id.slice(7); return `${SOURCE_LABEL[s] ?? `${s.charAt(0).toUpperCase()}${s.slice(1).replace(/_/g, ' ')}`} (signal type not graded)` }
  const s = id.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
