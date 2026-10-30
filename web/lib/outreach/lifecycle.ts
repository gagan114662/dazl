import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, TxBody } from '../db/client.ts'
import { tableExists } from './send-budget.ts'
import { norm } from './store.ts'

// #417: a prospect who signs up for dazl or pays leaves dazl's own acquisition outreach. Only the accounts the operator
// names as dazl's acquisition senders (DAZL_ACQUISITION_TENANTS, comma-separated tenant ids; unset = none) are
// affected: what a customer's own prospects do on dazl is never shown to, or acted on for, that customer's workspace.
//
// Matching is by the exact email address only (case-insensitive): an account email equal to an address dazl's
// acquisition outreach emailed. A same-domain or same-name signup is ambiguous and matches nothing.
//
// recordLifecycle is on the Db layer (both engines; the sign-up, Google and Stripe routes call it), convertedContact on
// the raw handle the send paths use.
//
// On a match, in one write transaction, everything not yet sent to that address stops: held autopilot first touches
// leave the queue, unsent approved drafts go back to draft, active sequences and warm follow-up threads stop with the
// conversion as their reason. The event itself is kept (one record per event id, so a replay or retry is a no-op), and
// the send path refuses any later acquisition email to the address (convertedContact), so a restart, a retry or a new
// cold play cannot bring it back. This is not the marketing suppression list (an opt-out); service email to the
// customer is a separate path this never touches. No onboarding email is sent from here: that needs its own policy.
// The event record lives in the audit log (action lifecycle_<kind>, detail = the address, message_id = the event id),
// so it needs no new table.

export type LifecycleKind = 'signup' | 'paid'
export interface LifecycleResult { matched: boolean; duplicate: boolean; stopped: { held: number; drafts: number; sequences: number; followups: number } }

export const acquisitionTenants = (env: Record<string, string | undefined> = process.env): string[] =>
  (env.DAZL_ACQUISITION_TENANTS ?? '').split(',').map(s => s.trim()).filter(Boolean)

const KINDS = ['lifecycle_signup', 'lifecycle_paid']

// The address became a customer (signed up or paid) for this acquisition tenant: no acquisition email may go to it.
export function convertedContact(db: Database.Database, tenantId: string, email: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!acquisitionTenants(env).includes(tenantId) || !tableExists(db, 'autopilot_audit')) return false
  return !!db.prepare(`SELECT 1 FROM autopilot_audit WHERE tenant_id = ? AND action IN (${KINDS.map(() => '?').join(',')}) AND detail = ?`).get(tenantId, ...KINDS, norm(email))
}

export async function recordLifecycle(db: Db, e: { kind: LifecycleKind; email: string; eventId: string; at?: number }, env: Record<string, string | undefined> = process.env): Promise<LifecycleResult[]> {
  const email = norm(e.email), at = e.at ?? Math.floor(Date.now() / 1000), action = `lifecycle_${e.kind}`, eventId = e.eventId.slice(0, 200)
  const out: LifecycleResult[] = []
  if (!email.includes('@') || !eventId) return out
  for (const tenantId of acquisitionTenants(env)) {
    out.push(await db.tx(function* (t): TxBody<LifecycleResult> {
      const r: LifecycleResult = { matched: false, duplicate: false, stopped: { held: 0, drafts: 0, sequences: 0, followups: 0 } }
      if (yield* t.get('SELECT 1 AS x FROM autopilot_audit WHERE tenant_id = ? AND action = ? AND message_id = ?', [tenantId, action, eventId])) return { ...r, duplicate: true }
      const leads = (yield* t.all<{ lead_id: string }>('SELECT DISTINCT lead_id FROM outreach_messages WHERE tenant_id = ? AND lower(to_email) = ?', [tenantId, email])).map(x => x.lead_id)
      // Recorded even when nothing was sent yet, so an existing customer is never picked up by a later cold play.
      yield* t.run('INSERT INTO autopilot_audit (id, tenant_id, lead_id, message_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [randomBytes(12).toString('hex'), tenantId, leads[0] ?? null, eventId, action, email, at])
      if (!leads.length) return r
      r.matched = true
      const inLeads = `(${leads.map(() => '?').join(',')})`
      const reason = `converted_${e.kind}`
      const exists = (name: string) => t.get(t.kind === 'pg' ? 'SELECT 1 AS x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?' : "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name])
      // autopilot_work: held first touches (#411), where that queue exists.
      if (yield* exists('autopilot_work')) r.stopped.held = (yield* t.run(`DELETE FROM autopilot_work WHERE tenant_id = ? AND lead_id IN ${inLeads}`, [tenantId, ...leads])).changes
      r.stopped.drafts = (yield* t.run("UPDATE outreach_messages SET status = 'draft', approved_hash = NULL WHERE tenant_id = ? AND lower(to_email) = ? AND status = 'approved'", [tenantId, email])).changes
      r.stopped.sequences = (yield* t.run(`UPDATE sequences SET status = 'stopped', stop_reason = ? WHERE tenant_id = ? AND lead_id IN ${inLeads} AND status IN ('draft','approved','active')`, [reason, tenantId, ...leads])).changes
      r.stopped.followups = (yield* t.run(`UPDATE followup_threads SET stopped = ? WHERE tenant_id = ? AND lead_id IN ${inLeads} AND stopped IS NULL`, [reason, tenantId, ...leads])).changes
      return r
    }))
  }
  return out
}
