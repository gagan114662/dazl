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
// What the two tables are. connector_claims holds one row per provider step the writer decided to attempt, and its status says
// how far that step got:
//   Apollo 'step:org ...'      the paid organization lookup  -> a COMPANY outcome (matched / not found / not this company)
//   Apollo 'step:people ...'   the people search             -> a CONTACT outcome
//   PDL    'people ...'        the people search             -> a CONTACT outcome
//   ok / empty / rejected      the step settled: the provider answered and the writer decided
//   reserved                   the claim was taken but never settled: a request MAY have been sent and MAY have been charged
// connector_audit repeats that story in a different shape: an Apollo attempt also writes a compatibility 'org X' row beside the
// org claim's own row, a PDL rejection writes a second descriptive row, and a company rejected at the org step settles the people
// claim WITHOUT calling the provider. Reading audit rows one-for-one reported three lookups and two results for one or two calls
// and let a matched company with zero contacts read as a contact success.
//
// The report therefore says only what the records establish:
//   lookups       provider steps that settled (the provider answered and the writer recorded the outcome)
//   unconfirmed   claims that never settled: reported, never counted as a completed lookup, never as a success
//   with_results  settled people lookups that attached a contact (a matched company is company_ok, never a result)
// A company rejected at the org step settles its people claim without a provider request; that claim is bound to ITS org claim
// (same connector, same identity key) before it stops counting as a lookup, never matched by reason text across identities.
// Records that cannot be read, or that cannot be told apart, stay unknown: they are never turned into a success.
export const PAID_ENRICH_CONNECTORS = ['enrich:apollo', 'enrich:pdl'] as const
// The pass itself records its own failures under the SHARED connector 'enrich' (lib/enrich/index.ts setupFailed 'pass setup':
// master key / scan setup unreadable; lib/signals/index.ts 'contact pass': the pass threw). Such a row is never a provider
// lookup and never a success, whatever its status says: it means the pass did not finish, so it is reported as a failure
// (pass_failed), never as "no key configured".
export const PAID_ENRICH_PASS_CONNECTOR = 'enrich'
// Audit statuses the writer records BEFORE any provider request (a key or lead record that could not be read).
const PRE_CALL_SETUP = /^setup (?:unreadable|failed)\b/
const HELD = new Set<string>([...ENRICH_SKIP_STATUSES, 'reserved', 'skipped', 'held'])
const NO_DOMAIN = 'contact rejected: no domain to confirm the company'
export interface PaidEnrichmentOutcomes {
  ok: number; empty: number; held: number; failed: number; total: number; unconfirmed: number; unreadable: boolean
  basis: 'claims' | 'audit_rows'
  passFailed: number // shared-connector 'enrich' rows: the pass failed in setup or threw (also counted in failed)
  company: { ok: number; empty: number; rejected: number }
  byProvider: { apollo: number; pdl: number }
}
const claimMemoRejection = (memo: string | null): string | null => {
  if (!memo) return null
  try { const m = JSON.parse(memo) as { rejected?: unknown }; return typeof m.rejected === 'string' && m.rejected ? m.rejected : null } catch { return null }
}
// The identity part of a claim key, so an org claim and its people claim can be paired: 'step:org <company> (<domain>)' and
// 'step:people <company> (<domain>)' share everything after the step word. A key that was shortened with a hash (#922) cannot
// be paired by text (the cut falls inside the identity), so it returns null: the pair stays unbound and is reported as such.
const identityOf = (lookup: string): string | null => {
  const m = /^step:(?:org|people) (.*)$/.exec(lookup)
  return m && !m[1].includes('#h:') ? m[1] : null
}
const providerOf = (connector: string): 'apollo' | 'pdl' => connector === 'enrich:pdl' ? 'pdl' : 'apollo'
export function paidEnrichmentOutcomes(db: Database.Database, tenantId: string, jobId: string): PaidEnrichmentOutcomes {
  const out: PaidEnrichmentOutcomes = { ok: 0, empty: 0, held: 0, failed: 0, total: 0, unconfirmed: 0, unreadable: false, passFailed: 0, basis: 'claims', company: { ok: 0, empty: 0, rejected: 0 }, byProvider: { apollo: 0, pdl: 0 } }
  const marks = PAID_ENRICH_CONNECTORS.map(() => '?').join(',')
  let audit: { connector: string; lookup: string; status: string; results: number }[]
  let claims: { connector: string; lookup: string; status: string; memo: string | null }[]
  try {
    audit = db.prepare(`SELECT connector, lookup, status, results FROM connector_audit WHERE tenant_id = ? AND scan_job_id = ? AND connector IN (${marks}) ORDER BY rowid`).all(tenantId, jobId, ...PAID_ENRICH_CONNECTORS) as typeof audit
  } catch { out.unreadable = true; return out }
  try { // the pass's own failure rows (shared connector): read with the same tenant + job scope
    const pass = db.prepare('SELECT COUNT(*) AS n FROM connector_audit WHERE tenant_id = ? AND scan_job_id = ? AND connector = ?').get(tenantId, jobId, PAID_ENRICH_PASS_CONNECTOR) as { n: number } | undefined
    out.passFailed = Number(pass?.n ?? 0); out.failed += out.passFailed
  } catch { out.unreadable = true; return out }
  // A claims table that cannot be read is NOT "no claims": the audit rows alone cannot tell a matched company from a contact, so
  // the stage is unknown rather than guessed.
  try {
    claims = db.prepare(`SELECT connector, lookup, status, memo FROM connector_claims WHERE tenant_id = ? AND scan_job_id = ? AND connector IN (${marks}) ORDER BY rowid`).all(tenantId, jobId, ...PAID_ENRICH_CONNECTORS) as typeof claims
  } catch { out.unreadable = true; return out }

  if (claims.length === 0) {
    // A job recorded before per-step claims: audit rows are all there is, so they are read by what each row IS, and the result
    // says it is not an exact lookup count. An organization row is a company outcome and never a contact result; the
    // compatibility 'org X' row repeats the org row and is counted once.
    out.basis = 'audit_rows'
    const seen = new Set<string>()
    for (const r of audit) {
      // A hold (budget, credits, circuit) or a setup row that could not read a key / lead was written BEFORE any request: it is
      // an outcome of its own, never a provider lookup (a new job whose every lead was held also has no claims and lands here).
      if (HELD.has(r.status)) { out.held++; continue }
      // #382: a lookup the scan's spend gate refused BEFORE sending (its claim released, lib/enrich/index.ts unsentStatus). Not a
      // lookup and not a failure; the provider's 'spend_refused' skip row above already reports the hold once.
      if (r.status.startsWith('not sent: ')) continue
      if (PRE_CALL_SETUP.test(r.status)) { out.failed++; continue }
      const org = /^(?:step:)?org /.test(r.lookup)
      const dedupe = `${r.connector}\u0000${org ? 'org ' + r.lookup.replace(/^(?:step:)?org /, '') : r.lookup}\u0000${r.status}\u0000${r.results}`
      if (org) { if (seen.has(dedupe)) continue; seen.add(dedupe) }
      out.total++; out.byProvider[providerOf(r.connector)]++
      if (org) {
        if (r.status === 'ok' && r.results > 0) out.company.ok++
        else if (r.status === 'ok' || r.status === 'empty') out.company.empty++
        else if (HELD.has(r.status)) out.held++
        else out.failed++
      } else if (r.status === 'ok' && r.results > 0) out.ok++
      else if (r.status === 'ok' || r.status === 'empty') out.empty++
      else if (HELD.has(r.status)) out.held++
      else out.failed++ // rejected (name_mismatch ...), provider errors, anything unknown
    }
    return out
  }

  const key = (c: string, l: string) => `${c}\u0000${l}`
  const claimed = new Set(claims.map(c => key(c.connector, c.lookup)))
  const statusOf = new Map<string, string>() // the claim's own audit row is settled in place; later descriptive rows do not replace it
  for (const r of audit) { const k = key(r.connector, r.lookup); if (claimed.has(k) && !r.status.startsWith('role-filtered')) statusOf.set(k, r.status) }

  // Org claims whose returned company was NOT this lead's, keyed by connector + identity. Their people claim never reached the provider.
  const orgRejected = new Map<string, string>() // connector|identity -> rejection reason
  for (const c of claims) {
    const id = c.lookup.startsWith('step:org ') ? identityOf(c.lookup) : null
    const why = claimMemoRejection(c.memo)
    if (id && why && c.status === 'ok') orgRejected.set(key(c.connector, id), why)
  }

  for (const c of claims) {
    const a = statusOf.get(key(c.connector, c.lookup))
    const reserved = c.status === 'reserved'
    const unsettled = () => { out.unconfirmed++; if (a && !HELD.has(a)) out.failed++ } // may have been sent / charged; a recorded failure code stays visible
    if (c.lookup.startsWith('step:org ')) {
      if (reserved) { unsettled(); continue }
      out.total++; out.byProvider[providerOf(c.connector)]++
      if (c.status === 'ok') { if (claimMemoRejection(c.memo)) out.company.rejected++; else out.company.ok++ }
      else if (c.status === 'empty') out.company.empty++
      else out.failed++
      continue
    }
    if (reserved) { unsettled(); continue }
    // A people claim settled 'rejected' may never have reached the provider: bound to ITS org claim by connector + identity (and the
    // org's recorded reason), or the no-domain refusal, which is only ever written before a request.
    let sent = true
    if (c.status === 'rejected' && a) {
      const id = identityOf(c.lookup)
      if (a === NO_DOMAIN) sent = false
      else if (id !== null && orgRejected.get(key(c.connector, id)) === a) sent = false
      else if (id === null && c.lookup.startsWith('step:people ') && a.startsWith('contact rejected')) { out.unconfirmed++; out.failed++; continue } // a hashed Apollo key cannot be bound to its org claim, so ANY rejection verdict (domain, location, address, organization, role...) is unknown: not a lookup, whatever the wording
    }
    if (sent) { out.total++; out.byProvider[providerOf(c.connector)]++ }
    if (c.status === 'ok') out.ok++
    else if (c.status === 'empty') out.empty++
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
  // lookups = steps that settled; unconfirmed = claimed but never settled; with_results = people lookups that attached a contact
  // (a matched company is company_ok, not a result). basis says whether this came from claims or, for old jobs, audit rows only.
  const detail = { pass_failed: o.passFailed, lookups: o.total, unconfirmed: o.unconfirmed, with_results: o.ok, empty: o.empty, held: o.held, failed: o.failed, company_ok: o.company.ok, company_empty: o.company.empty, company_rejected: o.company.rejected, apollo_lookups: o.byProvider.apollo, pdl_lookups: o.byProvider.pdl, basis: o.basis }
  if (o.unreadable) trace.note('paid_enrichment', 'failed', 'the paid-enrichment records could not be read, so what the paid lookups did is unknown', detail)
  else if (o.total === 0 && o.unconfirmed === 0 && o.held === 0 && o.failed === 0) trace.note('paid_enrichment', 'unavailable', 'no Apollo / People Data Labs key configured for this tenant, or no eligible lead', detail)
  else if (o.ok > 0) {
    const lookupFailed = o.failed - o.passFailed
    const also = [o.passFailed > 0 ? 'the paid-enrichment pass failed before finishing' : '', lookupFailed > 0 ? `${lookupFailed} ${lookupFailed === 1 ? 'was' : 'were'} rejected or failed` : '', o.unconfirmed > 0 ? `${o.unconfirmed} did not finish, so whether a request was sent is not confirmed` : ''].filter(Boolean)
    trace.note('paid_enrichment', 'ok', also.length ? `${o.ok} lookup${o.ok === 1 ? '' : 's'} returned a contact; ${also.join('; ')}` : null, detail)
  }
  else if (o.passFailed > 0) trace.note('paid_enrichment', 'failed', o.unconfirmed > 0 || o.failed > o.passFailed ? 'the paid-enrichment pass failed before finishing, and other lookups failed or did not finish; none returned a contact' : 'the paid-enrichment pass failed before finishing (setup could not be read, or the pass stopped); none returned a contact', detail)
  else if (o.failed > 0) trace.note('paid_enrichment', 'failed', o.unconfirmed > 0 ? 'paid lookups were rejected or failed or did not finish; none returned a contact' : 'paid lookups were rejected or failed; none returned a contact', detail)
  else if (o.unconfirmed > 0) trace.note('paid_enrichment', 'failed', 'a paid lookup did not finish, so whether a request was sent or charged is not confirmed; none returned a contact', detail)
  else if (o.empty > 0 || o.company.ok > 0 || o.company.empty > 0) trace.note('paid_enrichment', 'attempted_no_result', o.company.ok > 0 ? 'the company matched but no contact was found' : 'paid lookups ran and found no contact', detail)
  else trace.note('paid_enrichment', 'skipped', 'paid lookups were held (budget, credits, circuit or fallback off)', detail)
}
