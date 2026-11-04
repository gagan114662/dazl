// What must be reconciled on a restored store before sending may be re-enabled (issue #360; docs/RECOVERY.md step 6).
// Shared by recovery-drill.mts (reported) and send-gate.mts (enforced). Counts only, never rows.
//   messages_sending / messages_uncertain: an outreach claim whose provider outcome is unknown (resolveUncertain decides)
//   sequence_steps_unresolved / followups_unresolved: the same for sequence and follow-up steps
//   leases_unexpired: a worker lease taken on the OLD host that has not expired yet (its holder may still be running)
//   tenants_autopilot_on: informational (autopilot resumes sending once AUTOPILOT_KILL is lifted)
import type Database from 'better-sqlite3'

export type SendSafety = {
  messages_sending: number; messages_uncertain: number; sequence_steps_unresolved: number; followups_unresolved: number
  leases_unexpired: number; tenants_autopilot_on: number
}
export const BLOCKING: (keyof SendSafety)[] = ['messages_sending', 'messages_uncertain', 'sequence_steps_unresolved', 'followups_unresolved', 'leases_unexpired']

export function sendSafety(db: Database.Database, nowS = Math.floor(Date.now() / 1000)): SendSafety {
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
  const n = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n)
  return {
    messages_sending: has('outreach_messages') ? n("SELECT count(*) AS n FROM outreach_messages WHERE status = 'sending'") : 0,
    messages_uncertain: has('outreach_messages') ? n("SELECT count(*) AS n FROM outreach_messages WHERE status = 'uncertain'") : 0,
    sequence_steps_unresolved: has('sequence_steps') ? n("SELECT count(*) AS n FROM sequence_steps WHERE status IN ('sending','uncertain')") : 0,
    followups_unresolved: has('followup_messages') ? n("SELECT count(*) AS n FROM followup_messages WHERE status IN ('sending','uncertain')") : 0,
    leases_unexpired: has('app_leases') ? n('SELECT count(*) AS n FROM app_leases WHERE expires_at > ?', nowS) : 0,
    tenants_autopilot_on: has('autopilot_settings') ? n('SELECT count(*) AS n FROM autopilot_settings WHERE enabled = 1 AND paused = 0') : 0,
  }
}

// [] = nothing blocks re-enabling sending; otherwise the names of the counts still nonzero
export const blockers = (s: SendSafety) => BLOCKING.filter(k => s[k] !== 0)
