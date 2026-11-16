import type Database from 'better-sqlite3'
import { norm } from './store.ts'

// #855 (part of #727): one recipient is not emailed again from another play while the cooldown runs.
// A message counts as contact once it is sent, being sent, or of uncertain outcome (it may have reached them).
export const RECIPIENT_COOLDOWN_DAYS = 30
const DAY_S = 86400

// True when another lead of this tenant (another play's lead) contacted `toEmail` within the cooldown.
// The caller's own lead is left out: its own message is the one being drafted or approved.
export function recipientInCooldown(db: Database.Database, tenantId: string, toEmail: string, leadId: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const since = nowS - RECIPIENT_COOLDOWN_DAYS * DAY_S
  return !!db.prepare(
    "SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND lower(to_email) = ? AND lead_id <> ? AND status IN ('sent','sending','uncertain') AND COALESCE(sent_at, claimed_at, created_at) >= ? LIMIT 1",
  ).get(tenantId, norm(toEmail), leadId, since)
}
