import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getJob, MAX_ATTEMPTS } from '@/lib/scan/store'
import { kickRunner } from '@/lib/scan/runner'
import { sourceRuns } from '@/lib/scan/source-runs'
import { sourceStats } from '@/lib/search/trace'
import { modelUsage } from '@/lib/scan/model-usage'
import { runReportFor } from '@/lib/scan/run-report'
import { effectiveStatus, enrichState } from '@/lib/scan/enrichment'
import { emptyExtractionReason } from '@/lib/scan/extraction-note'
import { progressOf, outcomeInputs } from '@/lib/scan/progress'
import { scanOutcome } from '@/lib/scan/scan-outcome'
import { first5Of, isFirst5, verifiedLeads } from '@/lib/scan/first5'

// What a scan never stored, so a reader cannot mistake absence for a zero. Fixed list, not derived from data.
const NOT_RECORDED = ['search_queries', 'raw_search_hits', 'fetched_pages']
// When a scan DID record its search stats (scan_source_stats), these three exist; what still is not recorded is below.
const NOT_RECORDED_WITH_STATS = ['per_url_fetch_outcomes', 'model_token_usage']
const SOURCE_RUN_FIELDS = ['attempt', 'collector', 'status', 'evidence_count', 'candidate_count', 'verified_count', 'review_count', 'inserted_count'] as const

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  // Same 404 for "does not exist" and "belongs to someone else".
  const job = /^[a-f0-9]{24}$/.test(jobId) ? getJob(getScanDb(), user.id, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // polling also restarts retries and jobs reaped after a crash or restart
  // ?passive=1 is the explicit no-kick QA mode: it never starts provider work, though getJob may still reap a stale job.
  if (job.status === 'pending' && req.nextUrl.searchParams.get('passive') !== '1') after(() => kickRunner(getScanDb()))
  // Owner-scoped (sourceRuns joins scan_jobs.user_id), read only. Values are passed through as stored: NULL stays null (unknown), never 0.
  const source_runs = (sourceRuns(getScanDb(), user.id, job.id) as Record<string, unknown>[]).map(r => Object.fromEntries(SOURCE_RUN_FIELDS.map(f => [f, r[f] ?? null])))
  // null = the table was never created (stats recording is off or this scan predates it): "not recorded". [] = table exists, nothing for this job.
  const source_stats = sourceStats(getScanDb(), user.id, job.id)
  const recorded = !!source_stats && source_stats.length > 0
  // Owner-scoped model request/token totals; recorded:false (all null) when nothing was stored. Never a fabricated zero.
  const model_usage = modelUsage(getScanDb(), user.id, job.id)
  // Per-stage run report (queries, every result URL with date/selected/text/own-fetch, each candidate's fate and reason, funnel, model): null = not recorded.
  const run_report = runReportFor(getScanDb(), user.id, job.id)
  // Why a scan that searched and read pages still extracted nothing (counts only). null when extraction produced candidates or was not recorded.
  const empty_reason = emptyExtractionReason((run_report as { extraction?: never }[] | null)?.at(-1)?.extraction)
  const notRecorded = (recorded ? NOT_RECORDED_WITH_STATS : NOT_RECORDED).filter(x => !(x === 'model_token_usage' && model_usage.recorded && model_usage.tokens_complete) && !(x === 'per_url_fetch_outcomes' && run_report))
  // Live per-source progress (pollable while the scan runs) and the one honest outcome: failed (which source) / rejected (counts per reason) / zero-match / yielded N leads.
  const progress = progressOf(source_runs, effectiveStatus(job))
  const outcome = scanOutcome({ ...(job as object), id: job.id, status: effectiveStatus(job), error: job.error ?? null, empty_reason, ...outcomeInputs((run_report as unknown[] | null)?.at(-1) ?? null, source_runs, effectiveStatus(job)) } as never)
  // Code-decided completion: how many candidates are resolved (dated, company confirmed, contact attached) and the specific reason for each that is not.
  const resolution = (run_report as { resolution?: { candidates: number; resolved: number; unresolved: number; by_reason: Record<string, number> } }[] | null)?.findLast(r => r.resolution)?.resolution ?? null
  // The fast first scan: verified leads so far, live per-source progress, "finding more" and the distinct stop reason; never an empty state. Only for a job started with mode=first5.
  const first5 = isFirst5(getScanDb(), user.id, job.id) ? first5Of({ status: effectiveStatus(job), leads: verifiedLeads(getScanDb(), user.id, job.id), progress, outcome }) : undefined
  return NextResponse.json({ ...(first5 ? { first5 } : {}), progress, outcome, resolution, job_id: job.id, status: effectiveStatus(job), enrichment: { state: enrichState(job), started_at: job.enrich_started_at ?? null, finished_at: job.enrich_finished_at ?? null }, created_at: job.created_at, claimed_at: job.claimed_at, attempts: job.attempts, max_attempts: MAX_ATTEMPTS, lead_count: job.lead_count, quality: job.candidates === null ? null : { candidates: job.candidates, passed: job.verified, needs_review: job.needs_review, dropped: job.dropped, drop_reasons: job.drop_reasons ? JSON.parse(job.drop_reasons) : {} }, error: job.error === 'key_rejected' && (job as { funded_by?: string }).funded_by === 'trial' ? 'trial_key_invalid' : job.error, source_runs, source_stats, model_usage, run_report, empty_reason, not_recorded: notRecorded, query: job.query, icp: job.icp ? JSON.parse(job.icp) : null, icp_source: job.icp_inferred === 1 ? 'inferred' : job.icp_inferred === 2 ? 'request_only' : job.icp_inferred === 0 ? 'user' : null })
}
