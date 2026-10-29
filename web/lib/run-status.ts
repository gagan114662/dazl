import { scanOutcome, type ScanOutcome, type ScanOutcomeKind, type ScanRecord } from './scan/scan-outcome.ts'

// How a run ended, in one of a few states that each have their own next action, so the Campaigns list, a campaign's
// page and the Leads history never disagree (one said "failed" while another said "no candidates extracted"). The
// wording and the next step come from the shared recorded outcome (lib/scan/scan-outcome.ts); this only groups it:
// - technical: the run failed or was stopped (a source, the key, a budget, a time limit, a cancel) - not an empty search;
// - extraction: it ran, but nothing was extracted for checking (or an older run did not record its counts);
// - no_match: it completed, and nothing matched or nothing passed the checks;
// - results: it found leads (ready, or needing your review);
// - running: still searching or finishing.
export type RunGroup = 'running' | 'technical' | 'extraction' | 'no_match' | 'results'
export interface RunStatus { group: RunGroup; tag: string; kind: ScanOutcomeKind; label: string; detail: string | null; next: { text: string; href: string } | null }

const GROUP: Record<ScanOutcomeKind, RunGroup> = {
  running: 'running', enriching: 'running',
  failed: 'technical', stopped: 'technical',
  none_extracted: 'extraction', unrecorded: 'extraction',
  zero_match: 'no_match', all_dropped: 'no_match',
  leads: 'results', review_only: 'results',
}
const TAG: Record<ScanOutcomeKind, string> = {
  running: 'Running', enriching: 'Finishing',
  failed: 'Technical failure', stopped: 'Stopped',
  none_extracted: 'Nothing extracted', unrecorded: 'Not recorded',
  zero_match: 'Completed, no matches', all_dropped: 'Completed, none passed the checks',
  leads: 'Leads found', review_only: 'Needs your review',
}

// leads = the run's saved lead count when known: an older run that did not record its check counts but did save leads
// has results (its counts are what is missing), so it keeps the pipeline's next action.
export function runStatus(o: ScanOutcome, leads?: number | null): RunStatus {
  if (o.kind === 'unrecorded' && (leads ?? 0) > 0) return { group: 'results', tag: 'Leads found (counts not recorded)', kind: o.kind, label: o.label, detail: o.detail ?? null, next: o.next }
  return { group: GROUP[o.kind], tag: TAG[o.kind], kind: o.kind, label: o.label, detail: o.detail ?? null, next: o.next }
}
export const runStatusOf = (j: ScanRecord) => runStatus(scanOutcome(j), j.lead_count)

// A campaign row's status and next action. A run that produced no leads gets its own next step from the recorded
// outcome instead of a generic "Search failed"; a run with results keeps the pipeline's next action. Without a record
// (not in the history read), the row is left as it was.
export function campaignStatus<C extends { next: { label: string; href: string | null } }>(c: C, job: ScanRecord | null): C & { run: RunStatus | null } {
  if (!job) return { ...c, run: null }
  const run = runStatusOf(job)
  if (run.group === 'results') return { ...c, run }
  return { ...c, run, next: run.next ? { label: run.next.text, href: run.next.href } : c.next }
}
