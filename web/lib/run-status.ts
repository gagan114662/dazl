import { scanOutcome, type ScanOutcome, type ScanOutcomeKind, type ScanRecord } from './scan/scan-outcome.ts'
import { evidenceStateOf } from './outreach/evidence-state.ts'

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

// A run's saved leads as they stand now: what the user's review left, not what the scan recorded when it finished.
// The same split as the Campaigns funnel (lib/outreach/campaigns.ts): rejected = quarantined; of the rest, the evidence
// state first, then a review reason, else unverified.
export interface CurrentQual { leads: number; sourceChecked: number; confirmedByYou: number; needsReview: number; unverified: number; rejected: number }
type QualRow = { evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; quarantined_at: number | null }
export function currentQual(rows: QualRow[]): CurrentQual {
  const q: CurrentQual = { leads: rows.length, sourceChecked: 0, confirmedByYou: 0, needsReview: 0, unverified: 0, rejected: 0 }
  for (const r of rows) {
    const st = evidenceStateOf(r)
    if (r.quarantined_at !== null) q.rejected++
    else if (st === 'machine') q.sourceChecked++
    else if (st === 'human') q.confirmedByYou++
    else if (r.review_reason) q.needsReview++
    else q.unverified++
  }
  return q
}

// A run that found leads, restated from their current state: its label counts what is left now (never the scan-time
// "source-checked" count), and once the user has rejected every lead it is a run where none passed, with its own next
// step. A run without leads, or one still running or failed, is left as recorded.
export function currentRun(run: RunStatus, q: CurrentQual, query?: string | null): RunStatus {
  if (run.group !== 'results' || q.leads === 0) return run
  const leads = `${q.leads} lead${q.leads === 1 ? '' : 's'}`
  if (q.rejected >= q.leads) return {
    ...run, group: 'no_match', tag: 'None passed',
    label: `None passed: you rejected ${q.leads === 1 ? 'the 1 lead' : `all ${leads}`} this search found`,
    detail: 'Rejected leads stay in Leads under Rejected. Nothing from this search will be drafted.',
    next: { text: 'Try a broader search', href: query ? `/app/leads?q=${encodeURIComponent(query)}` : '/app/leads' },
  }
  const passed = q.sourceChecked + q.confirmedByYou
  const parts = [`${q.sourceChecked} source-checked`, `${q.confirmedByYou} confirmed by you`, `${q.needsReview} need${q.needsReview === 1 ? 's' : ''} your review`]
  if (q.unverified > 0) parts.push(`${q.unverified} unverified`)
  parts.push(`${q.rejected} rejected`)
  // An older run that did not record its check counts keeps saying so; the label still counts its leads as they are now.
  const tag = passed > 0 ? (run.kind === 'unrecorded' ? run.tag : 'Leads found') : q.needsReview > 0 ? 'Needs your review' : 'Not verified yet'
  return { ...run, tag, label: `${leads} found: ${parts.join(', ')}` }
}

// A campaign row's status and next action. A run that produced no leads gets its own next step from the recorded
// outcome instead of a generic "Search failed"; a run with results keeps the pipeline's next action, unless the user
// has since rejected all of them. Without a record (not in the history read), the row is left as it was.
type CampaignLike = { next: { label: string; href: string | null }; query?: string | null; discovery?: { leads: number }; qualification?: Omit<CurrentQual, 'leads'> }
export function campaignStatus<C extends CampaignLike>(c: C, job: ScanRecord | null): C & { run: RunStatus | null } {
  if (!job) return { ...c, run: null }
  let run = runStatusOf(job)
  if (c.discovery && c.qualification) run = currentRun(run, { ...c.qualification, leads: c.discovery.leads }, c.query)
  if (run.group === 'results') return { ...c, run }
  return { ...c, run, next: run.next ? { label: run.next.text, href: run.next.href } : c.next }
}
