import { scanOutcome, type ScanOutcome, type ScanOutcomeKind, type ScanRecord } from './scan/scan-outcome.ts'
import { evidenceStateOf } from './outreach/evidence-state.ts'
import { reviewIsActionable, uncheckableCause } from './lead-state.ts'

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
// state first, then a review reason - split into review a check can resolve and research it cannot (#683, the same verdict as
// Home: lib/lead-state.ts reviewIsActionable) - else unverified.
export interface CurrentQual { leads: number; sourceChecked: number; confirmedByYou: number; needsReview: number; research?: number; unverified: number; rejected: number }
type QualRow = { evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; quarantined_at: number | null; window_held?: boolean; gate_held?: boolean; human_confirmed_from?: string | null }
export function currentQual(rows: QualRow[]): CurrentQual & { research: number } {
  const q = { leads: rows.length, sourceChecked: 0, confirmedByYou: 0, needsReview: 0, research: 0, unverified: 0, rejected: 0 }
  for (const r of rows) {
    const st = evidenceStateOf(r)
    // A source-checked or confirmed lead is still research, never passed, if the time window holds it, it was
    // confirmed OUT of a hold a check cannot resolve, or it carries an uncheckable review_reason of its own (a lead
    // can be machine/human-verified AND still have a review_reason set - #683 round 3: the same verdict as leadStatus,
    // lib/outreach/campaign-view.ts, which checks review_reason before evidence state for exactly this case).
    // gate_held: a required check that has not passed (#1062) - the same hold the draft guard reads (requiredGateHeld).
    const held = r.window_held || r.gate_held || !!uncheckableCause(r.human_confirmed_from) || !!uncheckableCause(r.review_reason)
    if (r.quarantined_at !== null) q.rejected++
    else if ((st === 'machine' || st === 'human') && held) q.research++
    else if (st === 'machine') q.sourceChecked++
    else if (st === 'human') q.confirmedByYou++
    else if (r.review_reason) { if (reviewIsActionable(r)) q.needsReview++; else q.research++ }
    else if (r.gate_held) q.research++   // #1062: unverified, but a required check that has not passed holds it - checking cannot release it
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
  const research = q.research ?? 0
  if (research > 0) parts.push(`${research} research only`)
  if (q.unverified > 0) parts.push(`${q.unverified} unverified`)
  parts.push(`${q.rejected} rejected`)
  // An older run that did not record its check counts keeps saying so; the label still counts its leads as they are now.
  // An unverified lead is still actionable by checking its source (#683 round 3, haiku), so it must outrank "Research
  // only" here the same way it already does in the label/next-action guard above - "Research only" implies nothing
  // left can be changed, which isn't true while an unverified lead sits there.
  const tag = passed > 0 ? (run.kind === 'unrecorded' ? run.tag : 'Leads found') : q.needsReview > 0 ? 'Needs your review' : q.unverified > 0 ? 'Not verified yet' : research > 0 ? 'Research only' : 'Not verified yet'
  const label = `${leads} found: ${parts.join(', ')}`
  // Nothing passed and nothing a check can release: the scan-time "Review them" would hand the user failed research (#352/#683). Offer a
  // step that can change the result instead - but only when every lead is accounted for as research; an unverified lead
  // alongside it is still actionable by checking its source (#683 round 2), which "search again" would wrongly tell it to do instead.
  if (passed === 0 && q.needsReview === 0 && q.unverified === 0 && research > 0) return {
    ...run, tag, label,
    detail: `Checking ${research === 1 ? 'this lead' : 'these leads'} cannot make ${research === 1 ? 'it' : 'them'} ready (no usable date in your time window, someone else's customer, a different place, a closed opening, or a required check that could not run). Search again with a different signal or source.`,
    next: { text: 'Change the search', href: query ? `/app/leads?q=${encodeURIComponent(query)}` : '/app/leads' },
  }
  return { ...run, tag, label }
}

// A campaign row's status and next action. A run that produced no leads gets its own next step from the recorded
// outcome instead of a generic "Search failed"; a run with results keeps the pipeline's next action, unless the user
// has since rejected all of them. Without a record (not in the history read), the row is left as it was.
// The Campaigns funnel (lib/outreach/campaigns.ts) keeps a held lead no check can release in sourceChecked / confirmedByYou and reports
// it through heldResearch (heldResearchSourceChecked = its source-checked slice). Every reader that splits passed from research moves it
// out first, so the card's run pill, its Qualification stage and the campaign page count it once, as research (#683 review, finding 1).
export type ListQual = Omit<CurrentQual, 'leads'> & { heldResearch?: number; heldResearchSourceChecked?: number }
export function listQual(q: ListQual): Omit<CurrentQual, 'leads'> & { research: number } {
  const held = Math.max(0, q.heldResearch ?? 0), heldSc = Math.min(Math.max(0, q.heldResearchSourceChecked ?? 0), held)
  return { ...q, sourceChecked: Math.max(0, q.sourceChecked - heldSc), confirmedByYou: Math.max(0, q.confirmedByYou - (held - heldSc)), research: (q.research ?? 0) + held }
}
type CampaignLike = { next: { label: string; href: string | null }; query?: string | null; discovery?: { leads: number }; qualification?: ListQual }
export function campaignStatus<C extends CampaignLike>(c: C, job: ScanRecord | null): C & { run: RunStatus | null } {
  if (!job) return { ...c, run: null }
  let run = runStatusOf(job)
  if (c.discovery && c.qualification) run = currentRun(run, { ...listQual(c.qualification), leads: c.discovery.leads }, c.query)
  if (run.group === 'results') return { ...c, run }
  return { ...c, run, next: run.next ? { label: run.next.text, href: run.next.href } : c.next }
}

// The Leads history card of a past scan (#1136): the same status, label and next action as that scan's Campaigns card
// (campaignStatus over the leads as they stand now: a research-only run never says "need your review"). A scan with no
// campaign row (a test-only run or a CSV import - Campaigns lists neither) or one read while the campaigns read failed
// keeps its recorded outcome, and says so (current: false).
export type CampaignRun = { id: string; run: RunStatus | null; next: { label: string; href: string | null } }
export interface HistoryStatus { run: RunStatus; next: { text: string; href: string | null } | null; current: boolean }
export function historyStatus(j: ScanRecord, campaign: CampaignRun | undefined): HistoryStatus {
  if (campaign?.run) return { run: campaign.run, next: { text: campaign.next.label, href: campaign.next.href }, current: true }
  const run = runStatusOf(j)
  return { run, next: run.next, current: false }
}
// The pill colour for a run, one rule for every list: results that passed = mint, review a check can resolve = lavender.
export type RunTone = 'mint' | 'lav' | 'peach' | 'pink' | 'grey'
export function runTone(r: RunStatus): RunTone {
  if (r.group === 'running') return 'peach'
  if (r.group === 'technical') return 'pink'
  if (r.group !== 'results') return 'grey'
  return r.tag.startsWith('Leads found') ? 'mint' : r.tag === 'Needs your review' ? 'lav' : 'grey'
}
