import { readProviderIssues } from './provider-issues.ts'
import { costPerVerificationPass, COST_PER_PASS_SCOPE } from './cost-per-verification-pass.ts'
import { getJob } from './store-db.ts'
import { MAX_ATTEMPTS } from './store.ts'
import { numbers, readSourceRuns, readSourceStats, readModelUsage, readJobCost } from './status-reads.ts'
import { compareActual, type RunEstimate } from './price-estimate.ts'
import { readRunReport } from './run-report.ts'
import { effectiveStatus, enrichState } from './enrichment.ts'
import { emptyExtractionReason } from './extraction-note.ts'
import { progressOf, outcomeInputs } from './progress.ts'
import { scanOutcome } from './scan-outcome.ts'
import { readFirst5 } from './first5-db.ts'
import type { Db } from '../db/client.ts'

// What a scan never stored, so a reader cannot mistake absence for a zero. Fixed list, not derived from data.
const NOT_RECORDED = ['search_queries', 'raw_search_hits', 'fetched_pages']
// When a scan DID record its search stats (scan_source_stats), these three exist; what still is not recorded is below.
const NOT_RECORDED_WITH_STATS = ['per_url_fetch_outcomes', 'model_token_usage']
const SOURCE_RUN_FIELDS = ['attempt', 'collector', 'status', 'evidence_count', 'candidate_count', 'verified_count', 'review_count', 'inserted_count'] as const

// Pure read service. A missing/foreign job returns undefined. Mutations and dispatch remain in the legacy route adapter.
export async function readScanStatus(db: Db, tenantId: string, jobId: string) {
  if (!/^[a-f0-9]{24}$/.test(jobId)) return undefined
  const rawJob = await getJob(db, tenantId, jobId)
  if (!rawJob) return undefined
  const job = numbers(rawJob, ['created_at', 'claimed_at', 'attempts', 'finished_at', 'candidates', 'verified', 'needs_review', 'dropped', 'enrich_started_at', 'enrich_finished_at', 'lead_count', 'icp_inferred'])
  // Owner-scoped (sourceRuns joins scan_jobs.user_id), read only. Values are passed through as stored: NULL stays null (unknown), never 0.
  const source_runs = (await readSourceRuns(db, tenantId, job.id) as Record<string, unknown>[]).map(r => Object.fromEntries(SOURCE_RUN_FIELDS.map(f => [f, r[f] ?? null])))
  // null = the table was never created (stats recording is off or this scan predates it): "not recorded". [] = table exists, nothing for this job.
  const source_stats = await readSourceStats(db, tenantId, job.id)
  const recorded = !!source_stats && source_stats.length > 0
  // Owner-scoped model request/token totals; recorded:false (all null) when nothing was stored. Never a fabricated zero.
  const model_usage = await readModelUsage(db, tenantId, job.id)
  // Per-stage run report (queries, every result URL with date/selected/text/own-fetch, each candidate's fate and reason, funnel, model): null = not recorded.
  const run_report = await readRunReport(db, tenantId, job.id)
  // Why a scan that searched and read pages still extracted nothing (counts only). null when extraction produced candidates or was not recorded.
  const empty_reason = emptyExtractionReason((run_report as { extraction?: never }[] | null)?.at(-1)?.extraction)
  const notRecorded = (recorded ? NOT_RECORDED_WITH_STATS : NOT_RECORDED).filter(x => !(x === 'model_token_usage' && model_usage.recorded && model_usage.tokens_complete) && !(x === 'per_url_fetch_outcomes' && run_report))
  // Live per-source progress (pollable while the scan runs) and the one honest outcome: failed (which source) / rejected (counts per reason) / zero-match / yielded N leads.
  const progress = progressOf(source_runs, effectiveStatus(job))
  const outcome = scanOutcome({ ...(job as object), id: job.id, status: effectiveStatus(job), error: job.error ?? null, empty_reason, ...outcomeInputs((run_report as unknown[] | null)?.at(-1) ?? null, source_runs, effectiveStatus(job)) } as never)
  // Code-decided completion: how many candidates are resolved (dated, company confirmed, contact attached) and the specific reason for each that is not.
  const resolution = (run_report as { resolution?: { candidates: number; resolved: number; unresolved: number; by_reason: Record<string, number> } }[] | null)?.findLast(r => r.resolution)?.resolution ?? null
  // The fast first scan: verified leads so far, live per-source progress, "finding more" and the distinct stop reason; never an empty state. Only for a job started with mode=first5.
  const first5 = await readFirst5(db, tenantId, job.id, { status: effectiveStatus(job), progress, outcome })
  // Cost: what the user confirmed at the start, and only once the scan has ended, what was actually recorded beside it (reported tokens at the listed price; searches attempted). Absent for scans started before estimates existed.
  const saved = await readJobCost(db, tenantId, job.id)
  let cost: unknown = null
  try {
    const est = saved.estimate ? JSON.parse(saved.estimate) as Pick<RunEstimate, 'total' | 'rows' | 'payer' | 'cap'> : null
    if (est) {
      const ended = job.status === 'done' || job.status === 'failed'
      const actual = ended ? compareActual(est, { inputTokens: model_usage.input_tokens, outputTokens: model_usage.output_tokens, tokensComplete: model_usage.tokens_complete, model: model_usage.served_models?.[0] ?? model_usage.requested_models?.[0] ?? null, searches: source_stats && source_stats.length ? source_stats.reduce((a, r) => a + (Number((r as { searches_attempted?: unknown }).searches_attempted) || 0), 0) : null, reservedUsd: saved.reserved_usd, requests: model_usage.requests_recorded ?? null, requestsWithTokens: model_usage.requests_with_reported_tokens ?? null, capReservedUsd: saved.cap_reserved_usd }) : null
      // Cost per verification pass: the scan's own verified counter as denominator, model cost as
      // numerator - hygiene spend per pass, NOT cost per usable lead and never a qualified-lead
      // claim. Unknowns (running, unrecorded cost or count, zero passes) stay named, never 0/Infinity.
      cost = { estimate: { total: est.total, payer: est.payer, cap: est.cap, rows: est.rows }, actual, per_verification_pass: costPerVerificationPass({ verified: job.verified, model_usd: actual?.model_usd ?? null, scanEnded: ended }), model_scope: COST_PER_PASS_SCOPE }
    }
  } catch { cost = null }
  const provider_issues = await readProviderIssues(db, tenantId, job.id)
  return { ...(first5 ? { first5 } : {}), cost, provider_issues, progress, outcome, resolution, job_id: job.id, status: effectiveStatus(job), enrichment: { state: enrichState(job), started_at: job.enrich_started_at ?? null, finished_at: job.enrich_finished_at ?? null }, created_at: job.created_at, claimed_at: job.claimed_at, attempts: job.attempts, max_attempts: MAX_ATTEMPTS, lead_count: job.lead_count, quality: job.candidates === null ? null : { candidates: job.candidates, passed: job.verified, needs_review: job.needs_review, dropped: job.dropped, drop_reasons: job.drop_reasons ? JSON.parse(job.drop_reasons) : {} }, error: job.error === 'key_rejected' && (job as { funded_by?: string }).funded_by === 'trial' ? 'trial_key_invalid' : job.error, source_runs, source_stats, model_usage, run_report, empty_reason, not_recorded: notRecorded, query: job.query, icp: job.icp ? JSON.parse(job.icp) : null, icp_source: job.icp_inferred === 1 ? 'inferred' : job.icp_inferred === 2 ? 'request_only' : job.icp_inferred === 3 ? 'carried' : job.icp_inferred === 0 ? 'user' : null }

}
