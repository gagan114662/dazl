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
export type ScanOutcomeKind = 'running' | 'enriching' | 'leads' | 'review_only' | 'all_dropped' | 'none_extracted' | 'unrecorded' | 'stopped' | 'failed'
export interface ScanOutcome { kind: ScanOutcomeKind; label: string; detail?: string; next: { text: string; href: string } | null }
export interface ScanRecord {
  id: string; status: string; error: string | null; funded_by?: string | null
  candidates?: number | null; verified?: number | null; needs_review?: number | null; dropped?: number | null; lead_count?: number | null
  enrich_started_at?: number | null; enrich_finished_at?: number | null
  // The recorded extraction diagnostic for a scan that extracted nothing (server-computed; null when not recorded).
  empty_reason?: string | null
}

const NEW_SCAN = '/app/leads'
// The scan page shows what the run recorded about it (search results, pages read, what extraction was given).
const NONE_EXTRACTED = (open: string, why?: string | null): ScanOutcome => ({ kind: 'none_extracted', label: 'No candidates were extracted', detail: why || 'Nothing more was recorded about what the search returned. This does not show that no matching companies exist.', next: { text: 'See what the scan read', href: open } })
const TRIAL_KEY: ScanOutcome = { kind: 'failed', label: 'Failed - the free-search key had trouble (not your key)', next: { text: 'Try again later', href: NEW_SCAN } }

export function scanOutcome(j: ScanRecord): ScanOutcome {
  const open = `/app/leads?job_id=${j.id}`
  if (j.status === 'failed') {
    switch (j.error) {
      case 'no_candidates': return NONE_EXTRACTED(open, j.empty_reason)
      case 'budget_stopped': return { kind: 'stopped', label: 'Stopped by its budget - not an empty search', next: { text: 'Run it again with a larger budget', href: NEW_SCAN } }
      case 'scan_timeout': return { kind: 'stopped', label: 'Stopped at its time limit - nothing was saved', next: { text: 'Try a narrower search', href: NEW_SCAN } }
      case 'cancelled': return { kind: 'stopped', label: 'Cancelled', next: { text: 'Start a new scan', href: NEW_SCAN } }
      case 'key_unreadable': case 'no_api_key': return { kind: 'failed', label: 'Failed - your AI key could not be used', next: { text: 'Check your AI key in Settings', href: '/app/settings' } }
      case 'trial_key_invalid': return TRIAL_KEY
      case 'key_rejected':
        return j.funded_by === 'trial' ? TRIAL_KEY
          : { kind: 'failed', label: 'Failed - the AI provider rejected the key this scan used', next: { text: 'Check your AI key in Settings', href: '/app/settings' } }
      default: return { kind: 'failed', label: 'Failed', next: { text: 'Try again', href: NEW_SCAN } }
    }
  }
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
  if (found === 0 && verified === 0 && review === 0) return NONE_EXTRACTED(open, j.empty_reason)
  if (verified > 0) return { kind: 'leads', label: `${found} found: ${verified} source-checked, ${review} need${review === 1 ? 's' : ''} your review, ${dropped} dropped`, next: null }
  if (review > 0) return { kind: 'review_only', label: `${found} found: none passed the checks on their own, ${review} need${review === 1 ? 's' : ''} your review`, next: { text: `Review ${review === 1 ? 'it' : 'them'}`, href: open } }
  return { kind: 'all_dropped', label: `${found} found, all dropped by the checks`, next: { text: 'See why they were dropped', href: open } }
}
