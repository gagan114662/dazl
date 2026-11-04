// What the post-scan enrichment actually did, per stage, written into the run report so a lead that ends without a domain, contact or sales evidence can be
// explained instead of guessed at. Every stage is recorded as one of:
//   ok                   ran and produced something
//   attempted_no_result  ran, found nothing (the reasons are the connector audit statuses: name_mismatch, none_published, robots_disallow ...)
//   skipped              did not run on purpose (kill switch, run budget, no paid enrichment)
//   failed               threw or was cut off (post-finish time budget)
//   unavailable          cannot run (no key / feature off)
// Instrumentation only: nothing here changes a lead or a decision.
import type Database from 'better-sqlite3'

export type StageStatus = 'ok' | 'attempted_no_result' | 'skipped' | 'failed' | 'unavailable'
export interface StageNote { stage: string; status: StageStatus; reason: string | null; detail?: Record<string, number | string> }

export class EnrichmentTrace {
  readonly stages: StageNote[] = []
  note(stage: string, status: StageStatus, reason: string | null = null, detail?: Record<string, number | string>): void {
    const i = this.stages.findIndex(s => s.stage === stage)
    const n: StageNote = { stage, status, reason: reason ? reason.slice(0, 160) : null, ...(detail ? { detail } : {}) }
    if (i >= 0) this.stages[i] = n; else this.stages.push(n)
  }
}

// Audit statuses of one connector family for this job, counted. `results` is the number of items the lookup returned.
export function auditSummary(db: Database.Database, tenantId: string, jobId: string, connectorLike: string): { total: number; withResults: number; byStatus: Record<string, number> } {
  try {
    const rows = db.prepare('SELECT status, results FROM connector_audit WHERE tenant_id = ? AND scan_job_id = ? AND connector LIKE ?').all(tenantId, jobId, connectorLike) as { status: string; results: number }[]
    const byStatus: Record<string, number> = {}
    for (const r of rows) { const k = r.status.replace(/\b\d+\b/g, 'N').slice(0, 80); byStatus[k] = (byStatus[k] ?? 0) + 1 }
    return { total: rows.length, withResults: rows.filter(r => r.results > 0).length, byStatus }
  } catch { return { total: 0, withResults: 0, byStatus: {} } }
}
const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} x${v}`).join('; ')

export function noteFromAudit(trace: EnrichmentTrace, db: Database.Database, tenantId: string, jobId: string, stage: string, connectorLike: string): void {
  const s = auditSummary(db, tenantId, jobId, connectorLike)
  if (s.total === 0) trace.note(stage, 'attempted_no_result', 'no lookups were recorded (no eligible lead, or the stage was cut off before it wrote)')
  else trace.note(stage, s.withResults > 0 ? 'ok' : 'attempted_no_result', top(s.byStatus), { lookups: s.total, with_results: s.withResults })
}

// #389: the run report's 'tech' stage, from the technology branch's ledger rows (connector 'sitecrawl:tech', one per crawled site).
// Every outcome stays a named, visible state; none of them reads as a silent zero:
//   branch_never_ran            no ledger row: no confirmed company site was crawled in this run
//   crawl_ran_no_observations   rows exist, none observed: each row names why (no homepage verdict, not comparable) and the pages read
//   branch_error                the branch itself threw on at least one site (status 'failed', with the error names)
//   disabled                    TECH_SCAN_ENABLED=0: the branch did not run and wrote nothing
export function noteTech(trace: EnrichmentTrace, s: { total: number; withResults: number; byStatus: Record<string, number> }): void {
  const n = (prefix: string) => Object.entries(s.byStatus).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0)
  const observed = n('observed'), none = n('no_observation'), errors = n('error'), disabled = n('disabled')
  const detail = { sites: s.total, observed, no_observation: none, errors, disabled }
  if (s.total === 0) trace.note('tech', 'attempted_no_result', 'branch_never_ran: no confirmed company site was crawled in this run')
  else if (errors > 0) trace.note('tech', 'failed', `branch_error on ${errors} of ${s.total} sites: ${top(s.byStatus)}`, detail)
  else if (disabled === s.total) trace.note('tech', 'skipped', 'disabled: TECH_SCAN_ENABLED=0, the technology branch did not run', detail)
  else if (observed > 0) trace.note('tech', 'ok', top(s.byStatus), detail)
  else trace.note('tech', 'attempted_no_result', `crawl_ran_no_observations: ${top(s.byStatus)}`, detail)
}

// Adds the trace and the yield to the stored run report for this attempt (merge, never replaces the earlier stages). Never throws.
export function mergeIntoRunReport(db: Database.Database, jobId: string, attempt: number, patch: Record<string, unknown>): boolean {
  try {
    const row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ? AND attempt = ?').get(jobId, attempt) as { report: string } | undefined
    if (!row) return false
    const r = { ...(JSON.parse(row.report) as Record<string, unknown>), ...patch }
    const s = JSON.stringify(r); if (s.length > 120_000) return false
    db.prepare('UPDATE scan_run_report SET report = ? WHERE job_id = ? AND attempt = ?').run(s, jobId, attempt)
    return true
  } catch { return false }
}
