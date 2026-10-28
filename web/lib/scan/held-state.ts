// A REQUIRED gate (the sales-hiring check) that failed is a hold no human confirmation can clear. Confirming the lead or its domain says "the source / company is
// right"; it says nothing about the gate that could not run. Every drafting, approving and sending gate re-reads this state:
//   - the lead's stored review reason, or the reason it was confirmed FROM (confirmLeadReview moves review_reason into human_confirmed_from),
//   - the gate_failed marker beside the lead (written when the review write itself was rejected).
// It clears only when the gate runs again and passes (applySalesHiringGate removes the marker for a lead it passes).
import type Database from 'better-sqlite3'

export const SALES_GATE_HELD = 'sales_hiring_check_failed'

export function requiredGateHeld(db: Database.Database, tenantId: string, leadId: string): string | null {
  const row = db.prepare('SELECT l.review_reason, l.human_confirmed_from FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { review_reason: string | null; human_confirmed_from: string | null } | undefined
  if (!row) return null
  if (row.review_reason === SALES_GATE_HELD || row.human_confirmed_from === SALES_GATE_HELD) return SALES_GATE_HELD
  try {
    if (db.prepare("SELECT 1 FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'scan:gate' AND kind = 'gate_failed' LIMIT 1").get(leadId, tenantId)) return SALES_GATE_HELD
  } catch { /* no enrichments table: nothing was marked */ }
  return null
}
