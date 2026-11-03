// Durable, versioned machine timing proof (#377). Before this, a machine-verified lead stayed held by the currentness gate
// (lib/outreach/currentness.ts) until a person confirmed it, whatever its evidence: no proof could ever stand in for the
// review. This record is the explicit event-association contract that can: written at the end of a scan, one row per
// machine-verified lead, and honoured only when ALL of these hold, then and again at every read:
//   - timing: a recognized, trigger-compatible event-date proof (page_bound / ats_structured) on a valid past day inside
//     the request's window (proofBackedTiming). Publication, copyright, retrieval and model dates never qualify; a
//     request asking for recency without a numeric window is an unresolved bound and never qualifies;
//   - identity: a company domain the crawl confirmed, on a lead not sent to review and not quarantined;
//   - person + route: the scan's actionability check found a role-matching named person AND a contact route the company
//     published on its own site (lib/scan/actionable.ts);
//   - binding: the recorded event day, proof kind, domain and person/route are still the lead's current ones, and the
//     record is at the current TIMING_PROOF_VERSION. Any drift, an older version or no record at all holds (fail closed).
// Model confidence is never an input. Nothing here sets human_confirmed_at, and every other draft / approve / send gate
// (identity review, recipient purpose, suppression, launch authority, caps) still applies on top.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { addEnrichment, INTERNAL_ENRICHMENT_KIND } from '../connectors/store.ts'
import { proofBackedTiming, TIMING_REQUESTED } from './scoreboard.ts'
import { jobWindowDays } from './window.ts'

export const TIMING_PROOF_VERSION = 1
export const TIMING_PROOF_CONNECTOR = 'scan:timing-proof'
export const TIMING_PROOF_KIND = INTERNAL_ENRICHMENT_KIND // never listed for display (enrichmentsForLeads filters it)
export const TIMING_PROOF_LABEL = `timing-proof:v${TIMING_PROOF_VERSION}`
const ACTIONABLE_CONNECTOR = 'scan:actionable' // lib/scan/actionable.ts ACTIONABLE_CONNECTOR (not imported: avoids its memory/people deps)

export type TimingProofGap = 'no_lead' | 'not_machine_verified' | 'needs_review' | 'quarantined' | 'unresolved_recency_bound' | 'timing_unproven'
  | 'no_domain' | 'not_actionable' | 'no_record' | 'version_mismatch' | 'binding_changed'

interface Binding { v: number; proof: string; date: string; domain: string; route: string }
type LeadRow = { id: string; source_url: string; company_domain: string | null; event_date: string | null; event_date_proof: string | null; signal: string | null; signal_kind: string | null; review_reason: string | null; quarantined_at: number | null; confidence: number | null; query: string | null; icp: string | null }

const LEAD_SQL = `SELECT l.id, l.source_url, l.company_domain, l.event_date, l.event_date_proof, l.signal, l.signal_kind, l.review_reason, l.quarantined_at, l.confidence, j.query, j.icp
  FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`

// The facts as they are now, and the binding they make. A gap names the first failed condition, in the order above.
function evaluate(db: Database.Database, tenant: string, row: LeadRow | undefined, now: Date): { gap: TimingProofGap | null; binding: Binding | null } {
  if (!row) return { gap: 'no_lead', binding: null }
  if (row.confidence === null) return { gap: 'not_machine_verified', binding: null }
  if (row.review_reason !== null) return { gap: 'needs_review', binding: null }
  if (row.quarantined_at !== null) return { gap: 'quarantined', binding: null }
  const windowDays = jobWindowDays(row)
  if (windowDays == null && TIMING_REQUESTED.test(row.query ?? '')) return { gap: 'unresolved_recency_bound', binding: null }
  if (!proofBackedTiming(row, windowDays, now)) return { gap: 'timing_unproven', binding: null }
  if (!row.company_domain) return { gap: 'no_domain', binding: null }
  const act = db.prepare('SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? ORDER BY retrieved_at DESC').all(row.id, tenant, ACTIONABLE_CONNECTOR) as { value: string; label: string | null }[]
  // exactly one current actionability verdict, and it is the positive one with its person/route named
  if (act.length !== 1 || !act[0].value.startsWith('Actionable:') || !act[0].label) return { gap: 'not_actionable', binding: null }
  return { gap: null, binding: { v: TIMING_PROOF_VERSION, proof: row.event_date_proof!, date: row.event_date!, domain: row.company_domain, route: createHash('sha256').update(act[0].label).digest('hex').slice(0, 16) } }
}

// Scan end, after actionability: replace each machine-verified lead's record with the current verdict. A proven lead's
// record carries its binding; a held lead's record names its gap (so a later read can say why), and is never honoured.
export function recordTimingProof(db: Database.Database, job: { id: string; user_id: string }, now: Date = new Date()): { proven: number; held: number } {
  const ids = db.prepare("SELECT id FROM leads WHERE scan_job_id = ? AND confidence IS NOT NULL AND company <> ''").all(job.id) as { id: string }[]
  const del = db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ?')
  const read = db.prepare(LEAD_SQL)
  let proven = 0, held = 0
  for (const { id } of ids) {
    const row = read.get(id, job.user_id) as LeadRow | undefined
    const { gap, binding } = evaluate(db, job.user_id, row, now)
    const value = JSON.stringify(binding ? { state: 'proven', ...binding } : { state: 'held', v: TIMING_PROOF_VERSION, gap })
    del.run(id, job.user_id, TIMING_PROOF_CONNECTOR)
    addEnrichment(db, job.user_id, id, { connector: TIMING_PROOF_CONNECTOR, kind: TIMING_PROOF_KIND, value, label: TIMING_PROOF_LABEL, confidence: null, source_url: /^https?:\/\//.test(row?.source_url ?? '') ? row!.source_url.slice(0, 500) : 'https://invalid.example/', source_date: now.toISOString().slice(0, 10), retrieved_at: Math.floor(now.getTime() / 1000) })
    if (binding) proven++; else held++
  }
  return { proven, held }
}

// Read side (the currentness gate, and through it the Leads view, drafts, approvals, sends and follow-ups): null when the
// recorded proof stands right now, else why it does not. Re-evaluates every condition; the record alone is not enough.
export function timingProofGap(db: Database.Database, tenant: string, leadId: string, now: Date = new Date()): TimingProofGap | null {
  const row = db.prepare(LEAD_SQL).get(leadId, tenant) as LeadRow | undefined
  const cur = evaluate(db, tenant, row, now)
  if (cur.gap) return cur.gap
  const recs = db.prepare('SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?').all(leadId, tenant, TIMING_PROOF_CONNECTOR, TIMING_PROOF_KIND) as { value: string; label: string | null }[]
  if (recs.length === 0) return 'no_record'
  if (recs.length !== 1 || recs[0].label !== TIMING_PROOF_LABEL) return 'version_mismatch'
  let rec: Partial<Binding> & { state?: unknown } = {}
  try { rec = JSON.parse(recs[0].value) as typeof rec } catch { return 'binding_changed' }
  if (rec.v !== TIMING_PROOF_VERSION) return 'version_mismatch'
  const b = cur.binding!
  if (rec.state !== 'proven' || rec.proof !== b.proof || rec.date !== b.date || rec.domain !== b.domain || rec.route !== b.route) return 'binding_changed'
  return null
}
