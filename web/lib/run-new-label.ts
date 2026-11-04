// #387: what a run's "new" count means depends on the play kind. A weekly watch counts leads first seen in the run; a
// monitor counts ALERTS (novel, dated, in-window, verified events). Past monitor rows keep the old meaning (company keys
// not stored yet), so the monitor label says "alerts" to keep the two from being read as one series.
export function runNewLabel(kind: 'watch' | 'monitor', n: number): string {
  return kind === 'monitor' ? `${n} new alerts` : `${n} new`
}
