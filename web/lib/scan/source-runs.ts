import type Database from 'better-sqlite3'
import { dedupKey } from './evidence.ts'
import type { Candidate } from './evidence.ts'
import { writeSourceStats, type SourceStats } from '../search/trace.ts'
import { buildRunReport, writeRunReport, type ReportParts } from './run-report.ts'
import { writeModelCalls, type ModelCall } from './model-usage.ts'

// Discovery-stage provenance, not URL-domain classification. Counters are per
// collector and may overlap: one candidate can be credited to several collectors.
// Unknown measurements are NULL; old scans are deliberately not backfilled.
export function migrateSourceRuns(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_source_runs (
      job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      collector TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_count INTEGER,
      candidate_count INTEGER,
      verified_count INTEGER,
      review_count INTEGER,
      inserted_count INTEGER NOT NULL,
      PRIMARY KEY (job_id, attempt, collector)
    );
    CREATE TABLE IF NOT EXISTS lead_sources (
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      collector TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      PRIMARY KEY (lead_id, collector, attempt)
    );
  `)
}

// Match the actual surviving evidence, not merely a company that another source found.
const evidenceKey = (c: Pick<Candidate, 'company' | 'name' | 'source_url'>) => `${dedupKey(c)}|${c.source_url}`

type Run = { status: string; evidence: number | null; candidates: Set<string>; observed: boolean }
export class SourceRunLedger {
  private runs = new Map<string, Run>()
  private credits = new Map<string, Set<string>>()
  private diag = new Map<string, SourceStats>()
  private calls: ModelCall[] = []
  private written = 0 // calls already persisted; the next flush starts here, so nothing is written twice
  model(c: ModelCall): void { this.calls.push(c) }
  private parts: ReportParts = {}
  // Stage facts for the run report (scan/run-report.ts); merged, written once with the job.
  report(p: ReportParts): void { this.parts = { ...this.parts, ...p } }
  // Whole-attempt usage from the canonical call list (research calls count as requests with unknown tokens): never a TinyFish-stage snapshot.
  private modelSummary(): NonNullable<ReportParts['model']> {
    const known = this.calls.filter(c => c.input_tokens !== null && c.output_tokens !== null)
    return { requests_recorded: this.calls.length, requests_with_reported_tokens: known.length, input_tokens: known.length ? known.reduce((a, c) => a + c.input_tokens!, 0) : null, output_tokens: known.length ? known.reduce((a, c) => a + c.output_tokens!, 0) : null, tokens_complete: this.calls.length > 0 && known.length === this.calls.length }
  }
  // Persists model calls recorded since the last flush. finish() flushes what the scan made up to that point; the
  // post-finish steps (buyer-fit and any later model call) flush again, so their requests are not lost. Only the attempt
  // that still OWNS the job writes (same job id, attempt number and tenant as the job row), and (job, attempt, seq) is
  // unique, so a repeat flush cannot duplicate a row. Never throws.
  flushModelCalls(db: Database.Database, jobId: string, attempt: number): void {
    try {
      const own = db.prepare('SELECT user_id FROM scan_jobs WHERE id = ? AND attempts = ?').get(jobId, attempt) as { user_id: string } | undefined
      if (!own || this.written >= this.calls.length) return
      writeModelCalls(db, own.user_id, jobId, attempt, this.calls.slice(this.written), process.env, this.written)
      this.written = this.calls.length
    } catch { /* usage recording never affects the scan */ }
  }
  has(collector: string): boolean { return this.runs.has(collector) }
  stats(collector: string, s: SourceStats): void { this.diag.set(collector, s) }
  record(collector: string, status: string, evidence: number | null = null): void {
    const old = this.runs.get(collector)
    this.runs.set(collector, { status, evidence, candidates: old?.candidates ?? new Set(), observed: old?.observed ?? false })
  }
  candidates(collector: string, rows: Candidate[]): void {
    if (!this.runs.has(collector)) this.record(collector, 'ok')
    this.runs.get(collector)!.observed = true
    for (const row of rows) {
      const key = evidenceKey(row)
      this.runs.get(collector)!.candidates.add(key)
      if (!this.credits.has(key)) this.credits.set(key, new Set())
      this.credits.get(key)!.add(collector)
    }
  }
  // A selected adapter's ID comes from the call boundary, not the cited host.
  evidenceCandidates(items: { source: string; url: string }[], rows: Candidate[]): void {
    const byUrl = new Map<string, Set<string>>()
    for (const item of items) {
      if (!byUrl.has(item.url)) byUrl.set(item.url, new Set())
      byUrl.get(item.url)!.add(item.source)
    }
    for (const sources of byUrl.values()) for (const source of sources) this.candidates(source, [])
    for (const row of rows) for (const collector of byUrl.get(row.source_url) ?? []) this.candidates(collector, [row])
  }
  // Called inside finish's existing job-ownership transaction, after inserts.
  write(db: Database.Database, jobId: string, attempt: number, verified: Candidate[] | null, review: Candidate[] | null, insertedKeys: Set<string>): void {
    const verifiedKeys = new Set(verified?.map(evidenceKey))
    const reviewKeys = new Set(review?.map(evidenceKey))
    const stored = db.prepare('SELECT id, company, name, signal, source_url, dedup_key FROM leads WHERE scan_job_id = ?').all(jobId) as (Candidate & { id: string; dedup_key: string })[]
    const ins = db.prepare('INSERT OR REPLACE INTO scan_source_runs (job_id,attempt,collector,status,evidence_count,candidate_count,verified_count,review_count,inserted_count) VALUES (?,?,?,?,?,?,?,?,?)')
    for (const [collector, run] of this.runs) {
      const count = (keys: Set<string>) => [...run.candidates].filter(k => keys.has(k)).length
      ins.run(jobId, attempt, collector, run.status === 'started' ? 'error' : run.status, run.evidence, run.observed || run.evidence === 0 ? run.candidates.size : null, verified && (run.observed || run.evidence === 0) ? count(verifiedKeys) : null, review && (run.observed || run.evidence === 0) ? count(reviewKeys) : null, [...run.candidates].filter(k => insertedKeys.has(k)).length)
    }
    for (const [collector, s] of this.diag) writeSourceStats(db, jobId, attempt, collector, s) // on unless DAZL_SOURCE_STATS=0; never throws
    this.flushModelCalls(db, jobId, attempt) // never throws; failed and retried attempts included
    this.parts = { ...this.parts, model: this.modelSummary() }
    writeRunReport(db, jobId, attempt, buildRunReport(this.parts, verified ? verified.map(r => ({ key: evidenceKey(r) })) : null, review ? review.map(r => ({ key: evidenceKey(r), review_reason: (r as { review_reason?: string }).review_reason })) : null, attempt)) // never throws
    const link = db.prepare('INSERT OR IGNORE INTO lead_sources (lead_id,collector,attempt) VALUES (?,?,?)')
    for (const l of stored) for (const collector of this.credits.get(evidenceKey(l)) ?? []) link.run(l.id, collector, attempt)
  }
}

export function sourceRuns(db: Database.Database, tenantId: string, jobId: string) {
  return db.prepare(`SELECT r.* FROM scan_source_runs r JOIN scan_jobs j ON j.id=r.job_id
    WHERE j.user_id=? AND j.id=? ORDER BY r.attempt,r.collector`).all(tenantId, jobId)
}
export function sourcesForLead(db: Database.Database, tenantId: string, leadId: string) {
  return db.prepare(`SELECT s.collector,s.attempt FROM lead_sources s JOIN leads l ON l.id=s.lead_id
    JOIN scan_jobs j ON j.id=l.scan_job_id WHERE j.user_id=? AND l.id=? ORDER BY s.attempt,s.collector`).all(tenantId, leadId)
}
