// The ending of a scan, stored with the scan: one of a few DISTINCT results a person can act on, with counts per reason and the final per-source numbers. Derived only from what the job recorded (job row,
// scan_source_runs, the run report) by the same functions the status route uses for the live view; written into the run report when the scan reaches a terminal state, so history shows the same ending.
//   failed             a technical failure: a source or an infrastructure step errored; an empty result is NOT proof that nothing matches
//   extraction_failed  sources returned evidence (or a source was unavailable) but no candidate could be extracted from it
//   rejected           candidates were found and none passed the checks on their own (dropped, or held for review) - counts per reason
//   no_match           every source answered and returned nothing, and none failed
//   yielded            at least one source-checked lead (the counts say how many others were held or dropped)
//   stopped            the scan was stopped (budget, time limit, cancelled) - not an empty search
import type Database from 'better-sqlite3'
import { progressOf, outcomeInputs } from './progress.ts'
import { scanOutcome, type ScanOutcome } from './scan-outcome.ts'
import { sourceRuns } from './source-runs.ts'
import { runReportFor } from './run-report.ts'
import { effectiveStatus } from './enrichment.ts'

export type OutcomeClass = 'failed' | 'extraction_failed' | 'rejected' | 'no_match' | 'yielded' | 'stopped' | 'active' | 'unrecorded'
export interface StoredSource { source: string; status: string; state: string; found: number | null; kept: number | null; review: number | null; rejected: number | null; note: string | null }
export interface StoredOutcome {
  class: OutcomeClass; kind: string; label: string; detail: string | null; next: ScanOutcome['next']
  counts: { found: number | null; verified: number | null; needs_review: number | null; dropped: number | null }
  reasons: Record<string, number>   // per reason: "review:quote_unconfirmed", "dropped:duplicate" ...
  failed_sources: string[]; partial_sources: string[]; sources: StoredSource[]; at: number
}

export function outcomeClass(k: ScanOutcome['kind']): OutcomeClass {
  switch (k) {
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    case 'none_extracted': return 'extraction_failed'
    case 'all_dropped': case 'review_only': return 'rejected'
    case 'zero_match': return 'no_match'
    case 'leads': return 'yielded'
    case 'running': case 'enriching': return 'active'
    default: return 'unrecorded'
  }
}

type JobRow = { id: string; status: string; error: string | null; funded_by: string | null; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; enrich_started_at: number | null; enrich_finished_at: number | null }
export function buildStoredOutcome(db: Database.Database, tenantId: string, jobId: string, nowS = Math.floor(Date.now() / 1000)): StoredOutcome | null {
  const job = db.prepare('SELECT id, status, error, funded_by, candidates, verified, needs_review, dropped, enrich_started_at, enrich_finished_at FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as JobRow | undefined
  if (!job) return null
  const lead_count = (db.prepare('SELECT count(*) AS n FROM leads WHERE scan_job_id = ?').get(jobId) as { n: number }).n
  const status = effectiveStatus(job, nowS)
  const rows = sourceRuns(db, tenantId, jobId) as Record<string, unknown>[]
  const rep = (runReportFor(db, tenantId, jobId) as Record<string, unknown>[] | null)?.at(-1) ?? null
  const ins = outcomeInputs(rep, rows, status)
  const o = scanOutcome({ ...job, status, lead_count, ...ins } as never)
  const progress = progressOf(rows, status)
  return {
    class: outcomeClass(o.kind), kind: o.kind, label: o.label, detail: o.detail ?? null, next: o.next,
    counts: { found: job.candidates, verified: job.verified, needs_review: job.needs_review, dropped: job.dropped },
    reasons: ins.reject_reasons ?? {}, failed_sources: ins.failed_sources, partial_sources: ins.partial_sources,
    sources: progress.map(p => ({ source: p.source, status: p.status, state: p.state, found: p.candidates, kept: p.accepted, review: p.review, rejected: p.rejected, note: p.note })), at: nowS,
  }
}

// Stored with the run report of the attempt (a minimal report row is created when the scan never wrote one, e.g. it failed before any source reported). Never throws.
export function recordFinalOutcome(db: Database.Database, tenantId: string, jobId: string): StoredOutcome | null {
  try {
    const o = buildStoredOutcome(db, tenantId, jobId); if (!o || o.class === 'active') return null
    const attempt = (db.prepare('SELECT attempts FROM scan_jobs WHERE id = ?').get(jobId) as { attempts: number }).attempts
    const row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ? AND attempt = ?').get(jobId, attempt) as { report: string } | undefined
    const merged = JSON.stringify({ ...(row ? JSON.parse(row.report) as object : {}), outcome: o })
    db.prepare('INSERT OR REPLACE INTO scan_run_report (job_id, attempt, report) VALUES (?, ?, ?)').run(jobId, attempt, merged)
    return o
  } catch { return null }
}
export function storedOutcomeFor(db: Database.Database, tenantId: string, jobId: string): StoredOutcome | null {
  try { return ((runReportFor(db, tenantId, jobId) as { outcome?: StoredOutcome }[] | null)?.findLast(r => r.outcome)?.outcome) ?? null } catch { return null }
}
