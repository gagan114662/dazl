import type Database from 'better-sqlite3'

// Human confirmation of a needs-review lead. dazl could not verify these leads, so the
// machine gates stay exactly as they are: the scan counters, the original review reason
// and the unconfirmed quote are all preserved. What changes is the workflow dead-end:
// a user who opened the source and checked the lead themselves can say so, and the lead
// becomes draft-eligible under an explicit "confirmed by you" label - never presented
// as source-checked. Confirming is reversible; unconfirming restores the exact reason.

const owns = "scan_job_id IN (SELECT id FROM scan_jobs WHERE user_id = ?)"

// Returns true when the lead moved out of review. False: not found, not the tenant's,
// not in review, or already confirmed - the caller reports "nothing changed".
export function confirmLeadReview(db: Database.Database, userId: string, leadId: string): boolean {
  const r = db.prepare(
    `UPDATE leads SET human_confirmed_at = CAST(strftime('%s','now') AS INTEGER), human_confirmed_from = COALESCE(review_reason, 'legacy_currentness_review'), review_reason = NULL
     WHERE id = ? AND ${owns} AND (review_reason IS NOT NULL OR confidence IS NOT NULL) AND human_confirmed_at IS NULL`,
  ).run(leadId, userId)
  return r.changes === 1
}

// Returns true when the confirmation was withdrawn and the original review reason restored.
export function unconfirmLeadReview(db: Database.Database, userId: string, leadId: string): boolean {
  const r = db.prepare(
    `UPDATE leads SET review_reason = CASE WHEN human_confirmed_from='legacy_currentness_review' THEN NULL ELSE human_confirmed_from END, human_confirmed_at = NULL, human_confirmed_from = NULL
     WHERE id = ? AND ${owns} AND human_confirmed_at IS NOT NULL`,
  ).run(leadId, userId)
  return r.changes === 1
}
