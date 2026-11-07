// What the post-scan enrichment actually did, per stage, written into the run report so a lead that ends without a domain, contact or sales evidence can be
// explained instead of guessed at. Every stage is recorded as one of:
//   ok                   ran and produced something
//   attempted_no_result  ran, found nothing (the reasons are the connector audit statuses: name_mismatch, none_published, robots_disallow ...)
//   skipped              did not run on purpose (kill switch, run budget, no paid enrichment)
//   failed               threw or was cut off (post-finish time budget)
//   unavailable          cannot run (no key / feature off)
// Instrumentation only: nothing here changes a lead or a decision.
import type Database from 'better-sqlite3'
import { ENRICH_SKIP_STATUSES } from './provider-issue-text.ts'

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

// Paid contact enrichment (#923). The writers record connector 'enrich:apollo' / 'enrich:pdl' exactly, so match those, not a
// bare provider prefix.
//
// One logical provider call = one CLAIM row (connector_claims; the writers settle exactly one claim per call):
//   Apollo 'step:org ...'      the paid organization lookup  -> a COMPANY outcome (matched / not found / not this company)
//   Apollo 'step:people ...'   the people search             -> a CONTACT outcome
//   PDL    'people ...'        the people search             -> a CONTACT outcome
// The audit table is a different shape: one attempt also writes a compatibility 'org X' row beside the org claim's own row, a
// PDL rejection writes a second descriptive row, and a company rejected at the org step settles the people claim WITHOUT
// calling the provider. Counting audit rows one-for-one therefore reported three lookups and two results for one or two
// calls and let a company-only match read as a contact success. Company success and contact success are kept apart:
// 'with_results' is the number of lookups that attached a contact, never a matched organization.
export const PAID_ENRICH_CONNECTORS = ['enrich:apollo', 'enrich:pdl'] as const
const HELD = new Set<string>([...ENRICH_SKIP_STATUSES, 'reserved', 'skipped', 'held'])
const NO_DOMAIN = 'contact rejected: no domain to confirm the company'
export interface PaidEnrichmentOutcomes {
  ok: number; empty: number; held: number; failed: number; total: number; unreadable: boolean
  company: { ok: number; empty: number; rejected: number }
}
const claimMemoRejection = (memo: string | null): string | null => {
  if (!memo) return null
  try { const m = JSON.parse(memo) as { rejected?: unknown }; return typeof m.rejected === 'string' && m.rejected ? m.rejected : null } catch { return null }
}
export function paidEnrichmentOutcomes(db: Database.Database, tenantId: string, jobId: string): PaidEnrichmentOutcomes {
  const out: PaidEnrichmentOutcomes = { ok: 0, empty: 0, held: 0, failed: 0, total: 0, unreadable: false, company: { ok: 0, empty: 0, rejected: 0 } }
  const marks = PAID_ENRICH_CONNECTORS.map(() => '?').join(',')
  let audit: { connector: string; lookup: string; status: string; results: number }[]
  let claims: { connector: string; lookup: string; status: string; memo: string | null }[]
  try {
    audit = db.prepare(`SELECT connector, lookup, status, results FROM connector_audit WHERE tenant_id = ? AND scan_job_id = ? AND connector IN (${marks}) ORDER BY rowid`).all(tenantId, jobId, ...PAID_ENRICH_CONNECTORS) as typeof audit
  } catch { out.unreadable = true; return out }
  try {
    claims = db.prepare(`SELECT connector, lookup, status, memo FROM connector_claims WHERE tenant_id = ? AND scan_job_id = ? AND connector IN (${marks})`).all(tenantId, jobId, ...PAID_ENRICH_CONNECTORS) as typeof claims
  } catch { claims = [] }

  if (claims.length === 0) {
    // No claim rows (a job from before per-call claims, or a database without them): the audit rows are all there is.
    for (const r of audit) {
      out.total++
      if (r.status === 'ok' && r.results > 0) out.ok++
      else if (r.status === 'ok' || r.status === 'empty') out.empty++
      else if (HELD.has(r.status)) out.held++
      else out.failed++ // rejected (name_mismatch ...), provider errors, anything unknown
    }
    return out
  }

  // The latest audit status per claimed lookup (the claim's own audit row is settled in place), and which audit rows belong to a claim.
  const key = (c: string, l: string) => `${c}\u0000${l}`
  const claimed = new Set(claims.map(c => key(c.connector, c.lookup)))
  const statusOf = new Map<string, { status: string; results: number }>()
  for (const r of audit) if (claimed.has(key(r.connector, r.lookup)) && !(statusOf.has(key(r.connector, r.lookup)) && r.status.startsWith('role-filtered'))) statusOf.set(key(r.connector, r.lookup), { status: r.status, results: r.results })

  // Organization claims whose returned company was NOT this lead's: the people claim they settle was never sent to the provider.
  const orgRejections = new Map<string, number>()
  for (const c of claims) if (c.lookup.startsWith('step:org ')) { const why = claimMemoRejection(c.memo); if (why) orgRejections.set(why, (orgRejections.get(why) ?? 0) + 1) }

  for (const c of claims) {
    const a = statusOf.get(key(c.connector, c.lookup))
    const heldOrFailed = () => { if (!a || HELD.has(a.status)) out.held++; else out.failed++ } // a reserved claim: held for review, or its failure code
    if (c.lookup.startsWith('step:org ')) {
      out.total++ // the paid organization lookup is a real call
      if (c.status === 'ok') { if (claimMemoRejection(c.memo)) out.company.rejected++; else out.company.ok++ }
      else if (c.status === 'empty') out.company.empty++
      else if (c.status === 'reserved') heldOrFailed()
      else out.failed++
      continue
    }
    // A contact step. Settled 'rejected' without a provider call: no domain to confirm, or the company already rejected at the org step.
    let called = true
    if (c.status === 'rejected' && a) {
      if (a.status === NO_DOMAIN) called = false
      else { const left = orgRejections.get(a.status) ?? 0; if (left > 0) { orgRejections.set(a.status, left - 1); called = false } }
    }
    if (called) out.total++
    if (c.status === 'ok') out.ok++
    else if (c.status === 'empty') out.empty++
    else if (c.status === 'reserved') heldOrFailed()
    else out.failed++ // contact rejected (company/role contradiction), anything unknown
  }
  // Audit rows with no claim never reached a provider: a deliberate hold (budget, credits, circuit) or a setup failure. The
  // compatibility 'org X' rows land here too (they only ever repeat an org claim) and are not events of their own.
  for (const r of audit) {
    if (claimed.has(key(r.connector, r.lookup)) || r.status === 'ok' || r.status === 'empty') continue
    if (HELD.has(r.status)) out.held++; else out.failed++
  }
  return out
}
export function notePaidEnrichment(trace: EnrichmentTrace, db: Database.Database, tenantId: string, jobId: string): void {
  const o = paidEnrichmentOutcomes(db, tenantId, jobId)
  // lookups = logical provider calls; with_results = lookups that attached a contact (a matched company is company_ok, not a result).
  const detail = { lookups: o.total, with_results: o.ok, empty: o.empty, held: o.held, failed: o.failed, company_ok: o.company.ok, company_empty: o.company.empty, company_rejected: o.company.rejected }
  if (o.unreadable) trace.note('paid_enrichment', 'failed', 'the paid-enrichment audit could not be read', detail)
  else if (o.total === 0 && o.held === 0 && o.failed === 0) trace.note('paid_enrichment', 'unavailable', 'no Apollo / People Data Labs key configured for this tenant, or no eligible lead', detail)
  else if (o.ok > 0) trace.note('paid_enrichment', 'ok', o.failed > 0 ? `${o.ok} lookup${o.ok === 1 ? '' : 's'} returned a contact; ${o.failed} ${o.failed === 1 ? 'was' : 'were'} rejected or failed` : null, detail)
  else if (o.failed > 0) trace.note('paid_enrichment', 'failed', 'paid lookups were rejected or failed; none returned a contact', detail)
  else if (o.empty > 0 || o.company.ok > 0 || o.company.empty > 0) trace.note('paid_enrichment', 'attempted_no_result', o.company.ok > 0 ? 'the company matched but no contact was found' : 'paid lookups ran and found no contact', detail)
  else trace.note('paid_enrichment', 'skipped', 'paid lookups were held (budget, credits, circuit or fallback off)', detail)
}
