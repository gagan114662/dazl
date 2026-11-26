import { enrichState } from './enrichment.ts'
import { CLAUDE_KEY_REQUIRED_COPY } from '../error-copy.ts'

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
// accounts_for_failed_source (#1157): this outcome already says which source failed and why the run still stopped the way it did
// (the allowance, or a clean zero from the other source). A view that would otherwise replace a 'stopped' outcome with
// "Failed - <source> had an error" (lib/scan/first5.ts) must show this one as it is.
// says_what_to_do (#1435): a search that never started (no Anthropic key, too little budget left, free searches not available). Its
// label and detail are the whole message, with the next step in them; the current-job view shows them as they are (outcomeOwnCopy).
export interface ScanOutcome { kind: ScanOutcomeKind; label: string; detail?: string; next: { text: string; href: string } | null; accounts_for_failed_source?: true; says_what_to_do?: true }
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
  // #1435, from the same stop block: what was left under the tightest limit and the least a search needs, when the search did not
  // start for lack of budget. Omitted or null when not recorded.
  stop_room?: { left_usd: number; needed_usd: number } | null
  // What the scan recorded as spent (scan_jobs.spend_reserved_usd), read successfully. Omitted (or null) when it could not be read: then no
  // claim about charges is made. Only a trial stop reads it (trialStopped).
  spend_usd?: number | string | null
  // #1157: the worst case still reserved for this scan's paid calls that never got an answer (scan_spend_calls 'reserved'), read
  // successfully. An accounting_uncertain stop counts that step as billed at this amount. Omitted (or null) when not read.
  uncertain_usd?: number | null
  uncertain_steps?: number | null
  trial_attempt_restored?: boolean
}
// #1157: a definite answer for an interrupted paid step - counted as billed at the amount reserved for it - never "may have been
// billed". The amount is shown rounded UP (to 1/100 of a cent when it is not a whole cent), so the page never names less than the
// ledger keeps counted against the limits.
const usd = (v: number) => { const up = Math.ceil(v * 1e4 - 1e-9) / 1e4; return `$${Math.abs(up * 100 - Math.round(up * 100)) < 1e-9 ? up.toFixed(2) : up.toFixed(4)}` }
const countedAmount = (j: ScanRecord) => typeof j.uncertain_usd === 'number' && Number.isFinite(j.uncertain_usd) && j.uncertain_usd > 0 ? usd(j.uncertain_usd) : null
const countedSteps = (j: ScanRecord) => typeof j.uncertain_steps === 'number' && Number.isSafeInteger(j.uncertain_steps) && j.uncertain_steps > 0 ? j.uncertain_steps : null
const reasonList = (r: Record<string, number> | null | undefined) => r ? Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/^(?:review|dropped):/, '').replace(/_/g, ' ')} x${v}`).join(', ') : ''
// Zero match is claimed only when EVERY recorded source genuinely returned nothing: the search came back with a recorded 0, no source failed, none returned evidence that
// extracted no candidates, and none was unavailable / not run (those are unknown, not zero).
const ZERO_MATCH = (): ScanOutcome => ({ kind: 'zero_match', label: 'Zero match - the sources returned nothing', detail: 'The search and the other sources came back with no results for this request, and none of them failed.', next: { text: 'Widen the search', href: NEW_SCAN } })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
// What the empty result honestly is, given every recorded source. Evidence that yielded no candidates and unavailable sources are named; neither is a zero result.
function emptyResult(j: ScanRecord, open: string): ScanOutcome {
  const ev = j.evidence_sources ?? [], unknown = j.unknown_sources ?? []
  if (ev.length) return { kind: 'none_extracted', label: 'No candidates were extracted', detail: `${ev.map(e => `${e.source} returned ${plural(e.evidence, 'item')}`).join('; ')}, none matched as candidates.${unknown.length ? ` ${unknown.join(', ')} was unavailable or has no recorded counts.` : ''} This is not a zero-results scan and does not show that no matching companies exist.`, next: { text: 'See what the scan read', href: open } }
  if (unknown.length) return { kind: 'none_extracted', label: 'No candidates - a source was unavailable', detail: `${unknown.join(', ')} was unavailable, not run or has no recorded counts (unknown, not zero), so the other sources returning nothing does not show that no company matches.`, next: { text: 'See what the scan read', href: open } }
  return j.search_hits === 0 ? ZERO_MATCH() : NONE_EXTRACTED(open, j.empty_reason)
}
const sourcesFailed = (j: ScanRecord) => (j.failed_sources ?? []).length > 0

const NEW_SCAN = '/app/leads'
// The scan page shows what the run recorded about it (search results, pages read, what extraction was given).
const NONE_EXTRACTED = (open: string, why?: string | null): ScanOutcome => ({ kind: 'none_extracted', label: 'No candidates were extracted', detail: why || 'Nothing more was recorded about what the search returned. This does not show that no matching companies exist.', next: { text: 'See what the scan read', href: open } })
const TRIAL_KEY: ScanOutcome = { kind: 'failed', label: 'Failed - the free-search service had trouble', next: { text: 'Try again later', href: NEW_SCAN } }
// A free scan that reached its spending limit (lib/billing/trial-budget.ts): it stopped early and kept what it found, in
// the review list, since some checks may not have run.
// "Nothing was charged" only when the scan's recorded spend is a number (or a numeric string, as Postgres returns it) that is exactly zero.
// Everything else says nothing about charges: undefined (a reader that could not read the spend), null, '', booleans, NaN, text, any spend,
// a negative number. A reader that read the row successfully and found the column empty passes 0 itself (the job guard saves its running
// reserve BEFORE each paid call, so an empty column on a settled scan means no paid call started); a failed read passes nothing.
const NOT_CHARGED = 'Nothing was charged.'
const nothingCharged = (j: ScanRecord) => {
  const s = j.spend_usd as unknown
  if (typeof s === 'number') return s === 0
  return typeof s === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(s) && Number(s) === 0
}
function trialStopped(j: ScanRecord, open: string): ScanOutcome {
  const review = j.needs_review ?? 0
  const free = nothingCharged(j) ? ` ${NOT_CHARGED}` : ''
  return review > 0
    ? { kind: 'stopped', label: `Stopped early: this free scan reached its spending limit. It kept ${review} result${review === 1 ? '' : 's'} found before it stopped.${free}`, detail: 'They are in your review list, because some checks may not have run on them before the scan stopped.', next: { text: `Review ${review === 1 ? 'it' : 'them'}`, href: open } }
    : { kind: 'stopped', label: `Stopped early: this free scan reached its spending limit before it found any companies.${free}`, detail: 'This is not an empty search: the scan stopped before it could finish looking.', next: { text: 'Try a narrower search', href: NEW_SCAN } }
}

const PARTIAL_KINDS: ScanOutcomeKind[] = ['leads', 'review_only', 'all_dropped', 'none_extracted', 'zero_match']
// #1157 (review at 7723d55f): the words the current-job view (app/app/leads/leads-client.tsx) shows for a failed job whose outcome
// already accounts for a failed source, instead of its fixed per-error copy, which would say "searched and found nothing" without
// naming the source that never ran. null for every other outcome: that view keeps its own copy. Reads the status payload's `outcome`.
export function outcomeOwnCopy(o: unknown): string | null {
  const x = o && typeof o === 'object' ? o as Partial<ScanOutcome> : null
  if (!x || (x.accounts_for_failed_source !== true && x.says_what_to_do !== true) || typeof x.label !== 'string' || !x.label) return null
  return typeof x.detail === 'string' && x.detail ? `${x.label}. ${x.detail}` : x.label
}

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
        // #1435: the search did not start because too little was left under a limit. Says how much, under which limit, and what a search needs.
        const room = j.stop_room, amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
        if (room && typeof room === 'object' && amount(room.left_usd) && amount(room.needed_usd)) {
          const limit = r === 'over_limit' ? "this run's spending limit" : r === 'owner_pool_limit' ? "the account's day or month spending limit" : r === 'trial_budget_reached' ? "this free scan's spending limit" : "this run's spending cap"
          return { kind: 'stopped', says_what_to_do: true, label: 'Not started - too little budget was left for a search', detail: `A search needs at least ${usd(room.needed_usd)} to start, and ${usd(room.left_usd)} was left under ${limit}. No search was run, so nothing was concluded about whether leads exist.`,
            next: r === 'over_limit' ? { text: 'Run it again with a larger budget', href: NEW_SCAN } : r === 'trial_budget_reached' ? { text: 'Review your plan in Settings', href: '/app/settings' } : { text: 'Try again later', href: NEW_SCAN } }
        }
        if (r === 'trial_budget_reached')   // TRIAL_BUDGET_REASON (trial-budget.ts); a free scan searches the web only in fixed-price calls
          return { kind: 'stopped', label: 'This free scan found no companies within its spending limit', detail: 'A free scan searches the web only in ways whose cost is fixed in advance, so this does not show that no company matches.', next: { text: 'Try a broader search', href: NEW_SCAN } }
        if (r === 'over_limit')   // the run's OWN max_usd guard refused (only exists when the run set one): the per-run remedy is true
          return { kind: 'stopped', label: 'Stopped by its budget - not an empty search', next: { text: 'Run it again with a larger budget', href: NEW_SCAN } }
        if (r === 'over_cap')   // the scan's recorded cap refused: the run's own budget OR the service's per-scan cap, origin not retained (spend-cap.ts) - name neither, advise neither
          return { kind: 'stopped', label: 'Stopped by its spending cap - not an empty search', detail: 'The run\'s recorded spending cap refused the next paid step before it ran. That cap may be the run\'s own budget or the service\'s per-scan limit; which one was binding was not kept with this stop.', next: { text: 'View search options', href: NEW_SCAN } }
        if (r === 'owner_pool_limit')   // OWNER_POOL_LIMIT_REASON (spend-pool.ts): the shared day/month pool refused, NOT this run's budget - never advise touching the per-scan budget
          return { kind: 'stopped', label: 'Stopped by the shared account spending limit - not an empty search', detail: 'The account-wide day/month spending limit refused the next paid step before it ran. The per-scan budget did not cause this: raising or removing it would not have searched further.', next: { text: 'Try again later', href: NEW_SCAN } }
        return { kind: 'stopped', label: 'Stopped before it could conclude', detail: 'This run was recorded as a budget stop, but its exact reason was not kept: it may not have been a budget limit, so raising or removing the budget may not change anything. Nothing was concluded about whether leads exist.', next: { text: 'Run the search again', href: NEW_SCAN } }
      }
      case 'source_error': return sourcesFailed(j)
        ? { kind: 'failed', label: `Failed - ${j.failed_sources!.join(', ')} had an error`, detail: 'A source failed, so the run stopped before it could conclude. The budget did not cause this: raising or removing it would not have searched further. This is not an empty search.', next: { text: 'Try again', href: NEW_SCAN } }
        : { kind: 'failed', label: 'Failed - a source had an error', detail: 'A source failed, so the run stopped before it could conclude. The budget did not cause this. This is not an empty search.', next: { text: 'Try again', href: NEW_SCAN } }
      // #1157: one source failed while another searched clean and found nothing: the search concluded with that source missing
      case 'no_discovery': if (sourcesFailed(j)) return { kind: 'stopped', accounts_for_failed_source: true, label: `Nothing found - ${j.failed_sources!.join(', ')} could not be searched`, detail: 'One source had an error and was skipped; the other sources this run could use searched and found nothing. Broader paid research was out of scope for this run. This does not show that no company matches: the skipped source may have had results.', next: { text: 'Try again', href: NEW_SCAN } }
        return { kind: 'stopped', label: 'Nothing found in the sources this run could use', detail: 'The sources this run was allowed to use searched and found nothing, and broader paid research was out of scope for it. This does not show that no company matches.', next: { text: 'Run a broader search', href: NEW_SCAN } }
      case 'no_lead_source': return { kind: 'stopped', label: 'Stopped - no lead source could run', detail: 'No source this run may use could search: the free news search did not run (switched off on this server, or the request has no usable profile) and the capped web search was off, not set up or refused before any search, so nothing was searched. Nothing was concluded about whether leads exist, and nothing was charged for a search.', next: { text: 'Start a new scan', href: NEW_SCAN } }
      case 'search_allowance_reached': { const o: ScanOutcome = { kind: 'stopped', label: 'Stopped - the web search allowance for today was used up', detail: 'The search step was refused before it sent anything because this account\'s web search allowance for the day (or its share of the platform\'s) is used up. It is not an empty search and not a budget limit: raising or removing the budget would not change it. Nothing was concluded about whether leads exist.', next: { text: 'Try again after the day turns over (UTC)', href: NEW_SCAN } }
        // #1157: the allowance is what stopped the main search; a source that also failed is named beside it, never instead of it
        return sourcesFailed(j) ? { ...o, accounts_for_failed_source: true, detail: `${o.detail} Also, ${j.failed_sources!.join(', ')} had an error and gave nothing either.` } : o }
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
      case 'native_search_accounting_pending': return { kind: 'stopped', label: 'Claude Web Search did not start', detail: 'A previous search for this workspace has not settled. Dazl did not send another search that could add charges.', next: null }
      case 'native_search_provider_limit': return { kind: 'stopped', label: 'Stopped after an unexpected Claude Web Search response', detail: 'Claude reported more searches or output than requested. Dazl recorded the usage and did not start any more paid steps.', next: null }
      case 'native_search_estimate_exceeded': return { kind: 'stopped', label: 'Stopped after Claude Web Search exceeded its estimate', detail: 'Dazl did not start any more paid steps after the search. Anthropic bills for actual usage. We did not determine whether matching leads exist.', next: null }
      case 'accounting_uncertain': {
        // The count and the amount come from the still-reserved spend rows; when they cannot be read the copy names neither.
        const amount = countedAmount(j), steps = countedSteps(j), many = steps !== null && steps > 1, paren = amount ? ` (${amount})` : ''
        const counted = `${many ? `${steps} paid steps` : steps === 1 ? 'one paid step' : 'the interrupted paid step'} counted as billed${paren}`
        const what = many ? `${steps} paid steps were interrupted before their answers came back, so they are counted as billed at the amount reserved for them${paren}, and they stay` : `A paid step was interrupted before its answer came back, so it is counted as billed at the amount reserved for it${paren}, and it stays`
        const o: ScanOutcome = { kind: 'stopped', label: `Stopped after an interruption - ${counted}`, detail: `${what} counted against your limits. dazl did not run ${many ? 'them' : 'it'} again automatically: that could bill the same step twice. Nothing was concluded about whether leads exist. A new scan runs paid steps again and may be charged again.${j.trial_attempt_restored ? ' This free scan does not count toward your free scans.' : ''}`, next: { text: 'Start a new scan', href: NEW_SCAN } }
        // An outage that names its source keeps that naming (never a bare interruption) and the same definite count.
        return sourcesFailed(j) ? { ...o, kind: 'failed', label: `Failed - ${j.failed_sources!.join(', ')} had an error; ${counted}` } : o }
      case 'scan_timeout': return { kind: 'stopped', label: 'Stopped at its time limit - nothing was saved', next: { text: 'Try a narrower search', href: NEW_SCAN } }
      case 'cancelled': return { kind: 'stopped', label: 'Cancelled', next: { text: 'Start a new scan', href: NEW_SCAN } }
      // #1435: dazl finds leads with Claude only, so a search needs an Anthropic key. Nothing ran in its place.
      case 'claude_key_required': return { kind: 'failed', says_what_to_do: true, label: 'Not started - Claude search is unavailable for this workspace', detail: CLAUDE_KEY_REQUIRED_COPY, next: { text: 'Review your plan in Settings', href: '/app/settings' } }
      case 'key_unreadable': case 'no_api_key': return { kind: 'failed', label: 'Failed - the AI service could not start', next: { text: 'Review your plan in Settings', href: '/app/settings' } }
      case 'trial_key_invalid': return TRIAL_KEY
      case 'trial_unavailable': return { kind: 'failed', says_what_to_do: true, label: 'Not started - free scans are not available right now', detail: 'No search was run.', next: { text: 'Try again later', href: NEW_SCAN } }
      case 'key_rejected':
        return j.funded_by === 'trial' ? TRIAL_KEY
          : { kind: 'failed', label: 'Failed - the AI provider refused a request', next: { text: 'Review your plan in Settings', href: '/app/settings' } }
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
