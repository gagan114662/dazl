import { requestedHiringRoles, roleNeedsSourceProof } from './hiring-role-match.ts'
// A REQUIRED gate (the sales-hiring check) that failed is a hold no human confirmation can clear. Confirming the lead or its domain says "the source / company is
// right"; it says nothing about the gate that could not run. Every drafting, approving and sending gate re-reads this state:
//   - the lead's stored review reason, or the reason it was confirmed FROM (confirmLeadReview moves review_reason into human_confirmed_from),
//   - the gate_failed marker beside the lead (written when the review write itself was rejected),
//   - the run report's `held_lead_ids` (the run keeps its own record even when both of the writes above were rejected),
//   - this process's memory (when nothing at all could be persisted).
// It clears only when the gate runs again and passes (applySalesHiringGate removes the marker for a lead it passes).
import type Database from 'better-sqlite3'
import { salesHiringRequired } from './sales-hiring-required.ts'

export const SALES_GATE_HELD = 'sales_hiring_check_failed'
// (No creation-date exemption: every machine-verified lead of a job that needs the proof needs a durable pass record.)

// Held in this process, for the case where nothing could be persisted. Bounded; cleared by a gate pass.
const inProcess = new Set<string>()
export function markHeldInProcess(tenantId: string, leadIds: string[]): void { for (const id of leadIds) { if (inProcess.size >= 10_000) inProcess.clear(); inProcess.add(`${tenantId}:${id}`) } }

// The run report is a separate row, and the one place #282 itself writes the held leads: `held_lead_ids`. It survives a rejected review write AND a rejected marker write.
function reportHolds(db: Database.Database, tenantId: string, leadId: string): boolean {
  try {
    const r = db.prepare('SELECT r.report FROM scan_run_report r JOIN leads l ON l.scan_job_id = r.job_id JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ? ORDER BY r.attempt DESC LIMIT 1').get(leadId, tenantId) as { report: string } | undefined
    if (!r) return false
    const ids = (JSON.parse(r.report) as { held_lead_ids?: unknown }).held_lead_ids
    return Array.isArray(ids) && ids.includes(leadId)
  } catch { return false }
}

// A gate that RAN AGAIN AND PASSED releases the lead: the marker, the report entry and the in-process entry all go.
export function releaseHeld(db: Database.Database, tenantId: string, jobId: string, leadIds: string[]): void {
  for (const id of leadIds) inProcess.delete(`${tenantId}:${id}`)
  for (const id of leadIds) { try { db.prepare("DELETE FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:gate' AND kind = 'gate_failed'").run(id) } catch { /* no marker table */ } }
  try {
    const rows = db.prepare('SELECT attempt, report FROM scan_run_report WHERE job_id = ?').all(jobId) as { attempt: number; report: string }[]
    for (const row of rows) {
      const rep = JSON.parse(row.report) as { held_lead_ids?: unknown }
      if (!Array.isArray(rep.held_lead_ids)) continue
      const keep = rep.held_lead_ids.filter(x => !leadIds.includes(String(x)))
      if (keep.length !== rep.held_lead_ids.length) { rep.held_lead_ids = keep; db.prepare('UPDATE scan_run_report SET report = ? WHERE job_id = ? AND attempt = ?').run(JSON.stringify(rep), jobId, row.attempt) }
    }
  } catch { /* no report table */ }
}

export function requiredGateHeld(db: Database.Database, tenantId: string, leadId: string): string | null {
  if (inProcess.has(`${tenantId}:${leadId}`)) return SALES_GATE_HELD
  const row = db.prepare('SELECT l.review_reason, l.human_confirmed_from, l.confidence, l.company, l.created_at, j.query, j.icp FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { review_reason: string | null; human_confirmed_from: string | null; confidence: number | null; company: string | null; created_at: number | null; query: string | null; icp: string | null } | undefined
  if (!row) return null
  if (row.review_reason === SALES_GATE_HELD || row.human_confirmed_from === SALES_GATE_HELD) return SALES_GATE_HELD
  let passed = false
  try {
    if (db.prepare("SELECT 1 FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'scan:gate' AND kind = 'gate_failed' LIMIT 1").get(leadId, tenantId)) return SALES_GATE_HELD
    const passValue = requestedHiringRoles(row.query, row.icp).some(roleNeedsSourceProof) ? 'requested_role_v1' : 'sales_hiring'
    passed = !!db.prepare("SELECT 1 FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'scan:gate' AND kind = 'gate_passed' AND value = ? LIMIT 1").get(leadId, tenantId, passValue)
  } catch { /* no enrichments table: nothing was marked */ }
  if (reportHolds(db, tenantId, leadId)) return SALES_GATE_HELD
  // DEFAULT-DENY, durable across processes, whatever the lead's age: when the request needs the sales-hiring proof, a machine-verified lead is usable only with a recorded PASS.
  // A lead with no pass record (the gate failed, was cut off, or every write of its failure was rejected, and the process was restarted) is held, whatever human confirmation
  // was given. There is no creation-date exemption and no dependency on any marker the gate writes before judging: nothing but a durable pass makes the lead draftable.
  if (!passed && row.review_reason === null && row.confidence !== null && !!row.company && salesHiringRequired(row.query, row.icp)) return SALES_GATE_HELD
  return null
}
