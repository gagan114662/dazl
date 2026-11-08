import { enrichState } from './enrichment.ts'

// What a past scan ended as, read only from what the scan job row records (status, error and the counts the runner
// writes when it finishes), with one next step each. Used by the Leads history, the Home plays and the campaign page so
// all three say the same thing. Cases the record cannot tell apart stay one honest outcome; nothing here is guessed:
// - a scan that finished before the counts were stored ('unrecorded') cannot say whether nothing matched or everything
//   was dropped, so it says exactly that;
// - a scan stopped by its budget, its time limit or a cancel never records what it had found so far, so it is reported
//   as stopped, never as empty;
// - any other failure stores free text, so it is a plain 'failed';
// - 'no_candidates' means nothing was extracted for checking, which is not proof that the search found no matching
//   companies, so it is never called "no matches"; the recorded extraction diagnostic (empty_reason, from the run
//   report: no search hits, no page text offered, or text offered and zero extracted) is shown when there is one;
// - a finished scan whose enrichment stage (contacts, fit) is still running reads as finishing (#254), and one whose
//   enrichment never ended says so;
// - a rejected key is the free-search key's only when the job is known to be trial-funded (funded_by 'trial'). Nothing
//   in the record proves a scan used the user's own key (the column defaults to 'user', also for rows from before it
//   existed), so every other rejection gets neutral wording: no owner and no service outage is claimed.
export type ScanOutcomeKind = 'running' | 'enriching' | 'leads' | 'review_only' | 'all_dropped' | 'zero_match' | 'none_extracted' | 'unrecorded' | 'stopped' | 'failed'
export interface ScanOutcome { kind: ScanOutcomeKind; label: string; detail?: string; next: { text: string; href: string } | null }
export interface ScanRecord {
  id: string; status: string; error: string | null; funded_by?: string | null
  candidates?: number | null; verified?: number | null; needs_review?: number | null; dropped?: number | null; lead_count?: number | null
  enrich_started_at?: number | null; enrich_finished_at?: number | null
  // The recorded extraction diagnostic for a scan that extracted nothing (server-computed; null when not recorded).
  empty_reason?: string | null
  // From the run report / source rows (lib/scan/progress.ts), when recorded: the sources that failed, the per-reason counts of everything rejected, and the number of search results.
  failed_sources?: string[] | null; reject_reasons?: Record<string, number> | null; search_hits?: number | null
  // Per-source findings (progress.ts): sources that returned evidence but extracted no candidates, and sources that were unavailable / not run.
  evidence_sources?: { source: string; evidence: number }[] | null; unknown_sources?: string[] | null
  // Sources that answered only in part (some requests / entries failed): named beside whatever the scan ended as - never read as ok, never as an empty result.
  partial_sources?: string[] | null
  // From the run report's stop block, when recorded: the exact spend-refusal reason that caused the stop. NULL means
  // not recorded (legacy rows) - never proof of any particular reason.
  stop_refusal_reason?: string | null
}
const reasonList = (r: Record<string, number> | null | undefined) => r ? Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/^(?:review|dropped):/, '').replace(/_/g, ' ')} x${v}`).join(', ') : ''
// Zero match is claimed only when EVERY recorded source genuinely returned nothing: the search came back with a recorded 0, no source failed, none returned evidence that
// extracted no candidates, and none was unavailable / not run (those are unknown, not zero).
const ZERO_MATCH = (j: ScanRecord, open: string): ScanOutcome => ({ kind: 'zero_match', label: 'Zero match - the sources returned nothing', detail: 'The search and the other sources came back with no results for this request, and none of them failed.', next: { text: 'Widen the search', href: NEW_SCAN } })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
// What the empty result honestly is, given every recorded source. Evidence that yielded no candidates and unavailable sources are named; neither is a zero result.
function emptyResult(j: ScanRecord, open: string): ScanOutcome {
  const ev = j.evidence_sources ?? [], unknown = j.unknown_sources ?? []
  if (ev.length) return { kind: 'none_extracted', label: 'No candidates were extracted', detail: `${ev.map(e => `${e.source} returned ${plural(e.evidence, 'item')}`).join('; ')}, none matched as candidates.${unknown.length ? ` ${unknown.join(', ')} was unavailable or has no recorded counts.` : ''} This is not a zero-results scan and does not show that no matching companies exist.`, next: { text: 'See what the scan read', href: open } }
  if (unknown.length) return { kind: 'none_extracted', label: 'No candidates - a source was unavailable', detail: `${unknown.join(', ')} was unavailable, not run or has no recorded counts (unknown, not zero), so the other sources returning nothing does not show that no company matches.`, next: { text: 'See what the scan read', href: open } }
  return j.search_hits === 0 ? ZERO_MATCH(j, open) : NONE_EXTRACTED(open, j.empty_reason)
}
const sourcesFailed = (j: ScanRecord) => (j.failed_sources ?? []).length > 0

const NEW_SCAN = '/app/leads'
// The scan page shows what the run recorded about it (search results, pages read, what extraction was given).
const NONE_EXTRACTED = (open: string, why?: string | null): ScanOutcome => ({ kind: 'none_extracted', label: 'No candidates were extracted', detail: why || 'Nothing more was recorded about what the search returned. This does not show that no matching companies exist.', next: { text: 'See what the scan read', href: open } })
const TRIAL_KEY: ScanOutcome = { kind: 'failed', label: 'Failed - the free-search key had trouble (not your key)', next: { text: 'Try again later', href: NEW_SCAN } }
// A free scan that reached its spending limit (lib/billing/trial-budget.ts): it stopped early and kept what it found, in
// the review list, since some checks may not have run.
function trialStopped(j: ScanRecord, open: string): ScanOutcome {
  const review = j.needs_review ?? 0
  return review > 0
    ? { kind: 'stopped', label: `Stopped early: this free scan reached its spending limit. It kept ${review} result${review === 1 ? '' : 's'} found before it stopped.`, detail: 'They are in your review list, because some checks may not have run on them before the scan stopped.', next: { text: `Review ${review === 1 ? 'it' : 'them'}`, href: open } }
    : { kind: 'stopped', label: 'Stopped early: this free scan reached its spending limit before it found any companies.', detail: 'This is not an empty search: the scan stopped before it could finish looking.', next: { text: 'Try a narrower search', href: NEW_SCAN } }
}

const PARTIAL_KINDS: ScanOutcomeKind[] = ['leads', 'review_only', 'all_dropped', 'none_extracted', 'zero_match']
export function scanOutcome(j: ScanRecord): ScanOutcome {
  const o = baseOutcome(j), partial = j.partial_sources ?? []
  if (partial.length === 0 || !PARTIAL_KINDS.includes(o.kind)) return o
  const note = `Partial: ${partial.join('; ')} - the result may be incomplete.`
  // A partial source can never leave an empty result reading as "the sources returned nothing".
  if (o.kind === 'zero_match') return { kind: 'none_extracted', label: 'No candidates - a source answered only in part', detail: `${note} The other sources returned nothing, which does not show that no company matches.`, next: o.next }
  return { ...o, detail: o.detail ? `${o.detail} ${note}` : note }
}
function baseOutcome(j: ScanRecord): ScanOutcome {
  const open = `/app/leads?job_id=${j.id}`
  if (j.status === 'failed') {
    switch (j.error) {
      case 'no_candidates': return sourcesFailed(j) ? { kind: 'failed', label: `Failed - ${j.failed_sources!.join(', ')} had an error`, detail: 'A source failed, so the empty result is not proof that nothing matches.', next: { text: 'Try again', href: NEW_SCAN } } : emptyResult(j, open)
      case 'budget_stopped': {
        // Only the typed report provenance (the run report's stop.spend_refusal_reason) may name a specific numeric
        // control. A legacy budget_stopped row kept no reason: never claim a limit refused, never advise changing one.
        const r = j.stop_refusal_reason ?? null
        if (r === 'trial_budget_reached')   // TRIAL_BUDGET_REASON (trial-budget.ts); a free scan searches the web only in fixed-price calls
          return { kind: 'stopped', label: 'This free scan found no companies within its spending limit', detail: 'A free scan searches the web only in ways whose cost is fixed in advance, so this does not show that no company matches.', next: { text: 'Try a broader search', href: NEW_SCAN } }
        if (r === 'over_limit')   // the run's OWN max_usd guard refused (only exists when the run set one): the per-run remedy is true
          return { kind: 'stopped', label: 'Stopped by its budget - not an empty search', next: { text: 'Run it again with a larger budget', href: NEW_SCAN } }
        if (r === 'over_cap')   // the scan's recorded cap refused: the run's own budget OR the service's per-scan cap, origin not retained (spend-cap.ts) - name neither, advise neither
          return { kind: 'stopped', label: 'Stopped by its spending cap - not an empty search', detail: 'The run\'s recorded spending cap refused the next paid step before it ran. That cap may be the run\'s own budget or the service\'s per-scan limit; which one was binding was not kept with this stop.', next: { text: 'Run the search again', href: NEW_SCAN } }
        if (r === 'owner_pool_limit')   // OWNER_POOL_LIMIT_REASON (spend-pool.ts): the shared day/month pool refused, NOT this run's budget - never advise touching the per-scan budget
          return { kind: 'stopped', label: 'Stopped by the shared account spending limit - not an empty search', detail: 'The account-wide day/month spending limit refused the next paid step before it ran. The per-scan budget did not cause this: raising or removing it would not have searched further.', next: { text: 'Try again later', href: NEW_SCAN } }
        return { kind: 'stopped', label: 'Stopped before it could conclude', detail: 'This run was recorded as a budget stop, but its exact reason was not kept: it may not have been a budget limit, so raising or removing the budget may not change anything. Nothing was concluded about whether leads exist.', next: { text: 'Run the search again', href: NEW_SCAN } }
      }
      case 'source_error': return sourcesFailed(j)
        ? { kind: 'failed', label: `Failed - ${j.failed_sources!.join(', ')} had an error`, detail: 'A source failed, so the run stopped before it could conclude. The budget did not cause this: raising or removing it would not have searched further. This is not an empty search.', next: { text: 'Try again', href: NEW_SCAN } }
        : { kind: 'failed', label: 'Failed - a source had an error', detail: 'A source failed, so the run stopped before it could conclude. The budget did not cause this. This is not an empty search.', next: { text: 'Try again', href: NEW_SCAN } }
      case 'no_discovery': return { kind: 'stopped', label: 'Nothing found in the sources this run could use', detail: 'The sources this run was allowed to use searched and found nothing, and broader paid research was out of scope for it. This does not show that no company matches.', next: { text: 'Run a broader search', href: NEW_SCAN } }
      case 'unbounded_fallback_hold': return { kind: 'stopped', label: 'Stopped - the free sources could not conclude', detail: 'The broader paid research step has no price bound, so the run stopped instead of starting it. Raising or removing the budget would not change this. Nothing was concluded about whether leads exist.', next: { text: 'Try again', href: NEW_SCAN } }
      case 'model_unpriced': return { kind: 'failed', label: 'Failed - the configured model has no known price', detail: 'No paid step was allowed because its cost could not be bounded. Raising the budget would not help.', next: { text: 'Check the model setup', href: '/app/settings' } }
      case 'spend_count_failed': return { kind: 'failed', label: 'Failed - a paid step\'s cost could not be estimated in advance', detail: 'The step was not sent. Raising the budget would not help.', next: { text: 'Try again', href: NEW_SCAN } }
      case 'spend_accounting_unavailable': return { kind: 'stopped', label: 'Stopped - spend accounting could not be written', detail: 'No further paid step was allowed. This is a safety stop, not a budget limit: raising the budget would not help. Nothing was concluded about whether leads exist.', next: { text: 'Try again', href: NEW_SCAN } }
      case 'ownership_lost': return { kind: 'failed', label: 'Failed - this run lost ownership of its own job', detail: 'Another process took the job over, so this run stopped. This was not a budget stop.', next: { text: 'Start a new scan', href: NEW_SCAN } }
      case 'spend_config_invalid': return { kind: 'failed', label: 'Failed - the spend configuration was invalid', detail: 'No paid step ran. Raising the budget would not help.', next: { text: 'Try again', href: NEW_SCAN } }
      case 'spend_refused': return { kind: 'stopped', label: 'Stopped - a paid step was refused before it was sent', detail: 'Nothing was concluded about whether leads exist.', next: { text: 'Try again', href: NEW_SCAN } }
      case 'accounting_failed': return { kind: 'stopped', label: 'Stopped - the cost of one paid step could not be recorded', detail: 'dazl did not retry it automatically. That step may have been billed, so its worst-case cost stays counted against your limits. This is not an empty search: nothing was concluded about whether leads exist. A new scan runs paid steps again and may be charged again.', next: { text: 'Start a new scan', href: NEW_SCAN } }
      case 'provider_rate_limited': return { kind: 'stopped', label: 'Stopped - the AI provider rate-limited a request', detail: 'The provider refused a request because of its rate limit. dazl did not retry it automatically, and it does not claim the request was free: it stays counted against your limits. Nothing was concluded about whether leads exist. A new scan runs paid steps again and may be charged again.', next: { text: 'Start a new scan', href: NEW_SCAN } }
      case 'provider_rejected': return { kind: 'stopped', label: 'Stopped - the AI provider refused a request', detail: 'The provider answered a request with a refusal. dazl did not retry it automatically, and it does not claim the request was free: it stays counted against your limits. Nothing was concluded about whether leads exist. A new scan runs paid steps again and may be charged again.', next: { text: 'Start a new scan', href: NEW_SCAN } }
      case 'accounting_uncertain': { const o: ScanOutcome = { kind: 'stopped', label: 'Stopped after an interruption - a paid step may already have been billed', detail: 'The scan was interrupted while a paid step was in flight, so dazl did not run it again automatically: that could bill the same step twice. The step stays counted against your limits. Nothing was concluded about whether leads exist. Starting a new scan runs paid steps again and may be charged again.', next: { text: 'Start a new scan', href: NEW_SCAN } }
        // An outage that names its source keeps that naming (never a bare interruption) and still says a paid step may have been billed.
        return sourcesFailed(j) ? { ...o, kind: 'failed', label: `Failed - ${j.failed_sources!.join(', ')} had an error; a paid step may already have been billed` } : o }
      case 'scan_timeout': return { kind: 'stopped', label: 'Stopped at its time limit - nothing was saved', next: { text: 'Try a narrower search', href: NEW_SCAN } }
      case 'cancelled': return { kind: 'stopped', label: 'Cancelled', next: { text: 'Start a new scan', href: NEW_SCAN } }
      case 'key_unreadable': case 'no_api_key': return { kind: 'failed', label: 'Failed - your AI key could not be used', next: { text: 'Check your AI key in Settings', href: '/app/settings' } }
      case 'trial_key_invalid': return TRIAL_KEY
      case 'trial_unavailable': return { kind: 'failed', label: 'Not started - free scans are not available right now', next: { text: 'Try again later', href: NEW_SCAN } }
      case 'key_rejected':
        return j.funded_by === 'trial' ? TRIAL_KEY
          : { kind: 'failed', label: 'Failed - the AI provider rejected the key this scan used', next: { text: 'Check your AI key in Settings', href: '/app/settings' } }
      default: return sourcesFailed(j)
        ? { kind: 'failed', label: `Failed - ${j.failed_sources!.join(', ')} had an error`, detail: 'A source or an infrastructure step failed; this is not an empty search.', next: { text: 'Try again', href: NEW_SCAN } }
        : { kind: 'failed', label: 'Failed', next: { text: 'Try again', href: NEW_SCAN } }
    }
  }
  if (j.status === 'done' && j.error === 'trial_budget_reached') return trialStopped(j, open)
  const enrich = enrichState(j)
  if (j.status === 'enriching' || enrich === 'running') return { kind: 'enriching', label: 'Finishing - finding contacts and checking fit', next: null }
  if (j.status !== 'done') return { kind: 'running', label: 'Still running', next: null }
  const o = finished(j, open)
  return enrich === 'interrupted' ? { ...o, label: `${o.label}; contacts and fit checks did not finish` } : o
}

function finished(j: ScanRecord, open: string): ScanOutcome {
  if (j.verified == null && j.needs_review == null) {
    const n = j.lead_count ?? 0
    return n > 0
      ? { kind: 'unrecorded', label: 'Counts unavailable - this older scan did not record its check results', next: { text: 'Open its leads', href: open } }
      : { kind: 'unrecorded', label: 'Finished with no leads - this older scan did not record whether nothing matched or everything was dropped', next: { text: 'Run the search again', href: NEW_SCAN } }
  }
  const verified = j.verified ?? 0, review = j.needs_review ?? 0, found = j.candidates ?? 0, dropped = j.dropped ?? 0
  // The runner only finishes 'done' after it had companies to check, but a 0 here still means exactly that.
  if (found === 0 && verified === 0 && review === 0) return sourcesFailed(j) ? { kind: 'failed', label: `Failed - ${j.failed_sources!.join(', ')} had an error`, detail: 'A source failed, so the empty result is not proof that nothing matches.', next: { text: 'Try again', href: NEW_SCAN } } : emptyResult(j, open)
  if (verified > 0) return { kind: 'leads', label: `${found} found: ${verified} source-checked, ${review} need${review === 1 ? 's' : ''} your review, ${dropped} dropped`, next: null }
  if (review > 0) return { kind: 'review_only', label: `${found} found: none passed the checks on their own, ${review} need${review === 1 ? 's' : ''} your review`, next: { text: `Review ${review === 1 ? 'it' : 'them'}`, href: open } }
  return { kind: 'all_dropped', label: `${found} found, all dropped by the checks`, ...(j.reject_reasons ? { detail: `Rejected: ${reasonList(j.reject_reasons)}.` } : {}), next: { text: 'See why they were dropped', href: open } }
}
