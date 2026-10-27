// One honest outcome per scan, so history and detail never disagree and every outcome carries its own next step:
//   search_failed - the search (or a required step) did not run or errored; says which and why. Nothing is concluded about whether leads exist.
//   all_rejected  - candidates were found, none qualified; the counts per rejection reason.
//   no_matches    - the search ran and answered, and nothing matched the request.
//   completed     - at least one source-checked lead.
// Older scans have no run report; for them an empty result stays "no_candidates_unknown" (not recorded whether the search failed).
import type Database from 'better-sqlite3'

export type OutcomeKind = 'queued' | 'running' | 'completed' | 'all_rejected' | 'no_matches' | 'search_failed' | 'stopped' | 'no_candidates_unknown'
export interface Outcome { kind: OutcomeKind; label: string; detail: string; reasons: Record<string, number>; next_step: string }
export interface OutcomeJob { status: string; error?: string | null; candidates?: number | null; verified?: number | null; needs_review?: number | null; dropped?: number | null; drop_reasons?: string | null }
export interface ReportSummary { searches_attempted: number | null; searches_ok: number | null; hits_unique_urls: number | null; hits_complete: boolean | null; searches_failed: Record<string, number> | null; extracted: number | null; review_reasons: Record<string, number>; drop_reasons: Record<string, number> }

const STOPPED: Record<string, string> = { budget_stopped: 'stopped by the per-run budget', cancelled: 'stopped by you', scan_timeout: 'ran past its time limit' }
const FAILED_WHY: Record<string, string> = { key_rejected: 'your model key was rejected', no_api_key: 'no model key is saved', key_unreadable: 'the saved model key could not be read', bad_output: 'the model returned an unusable reply', internal_error: 'an internal error' }
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
const list = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')

export function scanOutcome(job: OutcomeJob, rep: ReportSummary | null): Outcome {
  const none = {} as Record<string, number>
  if (job.status === 'pending') return { kind: 'queued', label: 'queued', detail: 'Waiting for a free slot.', reasons: none, next_step: 'Nothing to do; it starts on its own.' }
  if (job.status === 'running') return { kind: 'running', label: 'scanning', detail: 'The scan is running.', reasons: none, next_step: 'Wait for it to finish.' }
  let dropReasons: Record<string, number> = rep?.drop_reasons ?? {}
  if (!rep && job.drop_reasons) { try { dropReasons = JSON.parse(job.drop_reasons) } catch { /* keep {} */ } }
  const reviewReasons = rep?.review_reasons ?? {}
  const reasons = { ...dropReasons, ...Object.fromEntries(Object.entries(reviewReasons).map(([k, n]) => [`review: ${k}`, n])) }
  if (job.status === 'done') {
    const v = job.verified ?? 0, r = job.needs_review ?? 0
    if (v > 0) return { kind: 'completed', label: `${v} source-checked`, detail: `${v} source-checked lead${v === 1 ? '' : 's'}${r ? `, ${r} need your review` : ''}.`, reasons, next_step: 'Open the leads; review the ones that need a decision.' }
    if ((job.candidates ?? 0) > 0) return { kind: 'all_rejected', label: 'all candidates rejected', detail: `${job.candidates} candidate${job.candidates === 1 ? '' : 's'} found, none passed the checks (${list(reasons) || 'no reasons recorded'}).`, reasons, next_step: 'Open the review list: candidates held for timing or place can be confirmed from their source. To get qualified leads, widen the window or loosen the place, or run again.' }
    return { kind: 'no_matches', label: 'no matches', detail: 'The search ran and found nothing that matched.', reasons, next_step: 'Rephrase or widen the request (window, place, role).' }
  }
  const err = job.error ?? ''
  if (STOPPED[err]) return { kind: 'stopped', label: STOPPED[err], detail: `The scan ${STOPPED[err]}. Nothing was concluded about whether leads exist.`, reasons: none, next_step: err === 'budget_stopped' ? 'Run again without the budget or with a larger one.' : err === 'cancelled' ? 'Start a new scan when ready.' : 'Try again with a narrower search.' }
  if (err === 'no_candidates') {
    if (!rep) return { kind: 'no_candidates_unknown', label: 'nothing found (cause not recorded)', detail: 'No candidates were found. This scan predates the run report, so it is not recorded whether the search failed or simply matched nothing.', reasons: none, next_step: 'Run it again: the new run records which.' }
    const failed = rep.searches_failed && sum(rep.searches_failed) > 0 ? rep.searches_failed : null
    const attempted = rep.searches_attempted ?? 0
    if (attempted === 0 || failed || rep.hits_complete === false) {
      const why = failed ? list(failed) : attempted === 0 ? 'no search was sent' : 'some searches did not answer'
      return { kind: 'search_failed', label: 'search failed', detail: `Search problem: ${why}${rep.searches_ok ? ` (${rep.searches_ok} of ${attempted} searches answered)` : ''}. Nothing was concluded about whether leads exist.`, reasons: failed ?? none, next_step: 'Run again; if it repeats, the search provider or its daily limit is the cause, not your request.' }
    }
    if ((rep.hits_unique_urls ?? 0) > 0) return { kind: 'no_matches', label: 'no matches', detail: `The search answered with ${rep.hits_unique_urls} result page${rep.hits_unique_urls === 1 ? '' : 's'}, but none named a company matching the request.`, reasons: none, next_step: 'Rephrase or widen the request (window, place, role).' }
    return { kind: 'no_matches', label: 'no matches', detail: 'Every search answered and returned no results for this request.', reasons: none, next_step: 'Widen the window or place, or rephrase the role.' }
  }
  const why = FAILED_WHY[err] ?? (err ? `error: ${err.slice(0, 80)}` : 'an unrecorded error')
  return { kind: 'search_failed', label: `failed - ${why}`, detail: `The scan failed because ${why}. Nothing was concluded about whether leads exist.`, reasons: none, next_step: err === 'key_rejected' || err === 'no_api_key' || err === 'key_unreadable' ? 'Check the model key in Settings, then run again.' : 'Run again; if it repeats, tell support the scan id.' }
}

// Minimal columns from the stored run report (json_extract), owner-scoped, for many jobs at once. A job with no report is absent.
export function reportSummaries(db: Database.Database, tenantId: string, jobIds: string[]): Map<string, ReportSummary> {
  const out = new Map<string, ReportSummary>()
  if (jobIds.length === 0) return out
  try {
    const rows = db.prepare(`SELECT r.job_id AS id, json_extract(r.report, '$.search') AS search, json_extract(r.report, '$.extracted_candidates') AS ex, json_extract(r.report, '$.funnel') AS funnel
      FROM scan_run_report r JOIN scan_jobs j ON j.id = r.job_id WHERE j.user_id = ? AND r.job_id IN (${jobIds.map(() => '?').join(',')}) AND r.attempt = (SELECT MAX(attempt) FROM scan_run_report WHERE job_id = r.job_id)`).all(tenantId, ...jobIds) as { id: string; search: string | null; ex: number | null; funnel: string | null }[]
    for (const r of rows) {
      const s = r.search ? JSON.parse(r.search) as { attempted: number | null; ok: number | null; hits_unique_urls: number | null; hits_complete: boolean | null } : null
      const f = r.funnel ? JSON.parse(r.funnel) as { review_reasons: Record<string, number>; drop_reasons: Record<string, number> } : null
      const fails = db.prepare('SELECT searches_failed AS f, searches_not_attempted AS n FROM scan_source_stats WHERE job_id = ? ORDER BY attempt DESC LIMIT 1').get(r.id) as { f: string | null; n: string | null } | undefined
      let failed: Record<string, number> | null = null
      try { const a = fails?.f ? JSON.parse(fails.f) : {}; const b = fails?.n ? JSON.parse(fails.n) : {}; const m = { ...a, ...b }; failed = Object.keys(m).length ? m : null } catch { failed = null }
      out.set(r.id, { searches_attempted: s?.attempted ?? null, searches_ok: s?.ok ?? null, hits_unique_urls: s?.hits_unique_urls ?? null, hits_complete: s?.hits_complete ?? null, searches_failed: failed, extracted: r.ex, review_reasons: f?.review_reasons ?? {}, drop_reasons: f?.drop_reasons ?? {} })
    }
  } catch { /* no report table / unparseable: those jobs are treated as having no report */ }
  return out
}
