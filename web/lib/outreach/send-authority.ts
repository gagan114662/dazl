import type Database from 'better-sqlite3'
import { hasConsent } from './ledger.ts'
import { norm } from './store.ts'

// The shared authority recheck for every Gmail send handoff (Refs #739, #925, #405, #467).
// Call it synchronously right before the handoff, AFTER every await on the path (token fetch, reply sync, draft text, approval
// wait): authority can change during an await, and a send must reflect the state now, not the state when the path started.
// It re-reads, from the database, the things a person can change meanwhile:
//   - the sending identity: the connected account must still be active and still the address the message was prepared for
//   - suppression: an opt-out or bounce recorded meanwhile stops the send
//   - recipient consent: when the path relies on a ledger consent scope, it must still be valid and unrevoked
//   - the tenant switch: when the path runs under autopilot, autopilot must still be enabled and not paused (and follow-ups on)
// Returns null when the send may proceed, else the refusal reason. Any read that fails is a refusal ('authority_unreadable'):
// nothing is handed to Gmail on an authority nobody could read. The caller releases its claim and records no 'sent' state.
export interface SendAuthorityInput {
  to: string
  /** the address the message was prepared and approved to send from */
  sender: string
  /** the time at the handoff boundary: callers compute it immediately before this call, not when the path started */
  now: number
  /** 'enabled': the tenant's autopilot switch is on (a calibration check runs while autopilot is paused, so pause is not read);
   *  'running': on and not paused; 'followups': running and the warm follow-up switch on */
  autopilot?: 'enabled' | 'running' | 'followups'
  /** ledger consent scope the path relies on (email channel), e.g. 'followup' or 'sequence' */
  consentScope?: string
  /** when set, the consent row must carry exactly this evidence_ref (e.g. 'sequence:<id>'), so a grant for another
   *  sequence or flow to the same recipient never authorises this send */
  consentEvidenceRef?: string
}

export function recheckSendAuthority(db: Database.Database, tenantId: string, i: SendAuthorityInput): string | null {
  try {
    const acct = db.prepare('SELECT email, status FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string; status: string } | undefined
    if (!acct || acct.status !== 'active') return 'gmail_not_connected'
    if (acct.email.toLowerCase() !== i.sender.toLowerCase()) return 'sender_changed'
    if (db.prepare('SELECT 1 FROM suppressions WHERE tenant_id = ? AND email = ?').get(tenantId, norm(i.to))) return 'suppressed'
    if (i.consentScope) {
      const ok = i.consentEvidenceRef
        ? db.prepare("SELECT 1 FROM consent_ledger WHERE tenant_id = ? AND contact = ? AND channel = 'email' AND scope = ? AND evidence_ref = ? AND revoked_at IS NULL AND expires_at > ?").get(tenantId, norm(i.to), i.consentScope, i.consentEvidenceRef, i.now)
        : hasConsent(db, tenantId, i.to, 'email', i.consentScope, i.now)
      if (!ok) return 'no_consent'
    }
    if (i.autopilot) {
      const st = db.prepare('SELECT enabled, paused, followups_enabled FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as { enabled: number; paused: number; followups_enabled: number } | undefined
      if (!st || Number(st.enabled) !== 1) return 'autopilot_off'
      if (i.autopilot !== 'enabled' && Number(st.paused) === 1) return 'paused'
      if (i.autopilot === 'followups' && Number(st.followups_enabled) !== 1) return 'followups_off'
    }
    return null
  } catch {
    return 'authority_unreadable'
  }
}
