// Scheduled reply reading, independent of sending (#413). Reading replies, opt-outs and bounces is its own authority: the
// tenant's read consent plus the Gmail read grant. It does not depend on autopilot being enabled, unpaused or allowed to send
// follow-ups, so a first-touch-only account, or one whose sending is paused, still has its replies and opt-outs processed on
// every tick. Revoking read consent (or the read grant) stops every read: such a tenant is not selected, and syncReplies
// itself refuses before any provider call.
//
// Each sync is checkpointed per tenant (reply_sync_state): when it last ran, whether it succeeded, and whether bounce
// notices were covered. A failed or partial sync is recorded as failed, never as fresh, and the tick only lets follow-ups or
// sequences send for a tenant whose sync succeeded in that same tick.
import type Database from 'better-sqlite3'
import { hasReadConsent, syncReplies, type SyncResult } from './replies.ts'

export const READ_WINDOW_S = 120 * 86400   // the same window syncReplies reads threads in
export const FRESH_FOR_S = 2 * 3600

export function migrateReplySchedule(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reply_sync_state (
      tenant_id TEXT PRIMARY KEY,
      checked_at INTEGER NOT NULL,
      ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
      error TEXT CHECK (error IS NULL OR length(error) <= 60),
      bounce_coverage TEXT NOT NULL DEFAULT 'unknown' CHECK (bounce_coverage IN ('checked', 'unknown')),
      last_ok_at INTEGER
    );
  `)
}

// Tenants whose replies may be read now: read consent at the current version, an active Gmail account with the read grant,
// and at least one sent message inside the read window. Autopilot and follow-up settings play no part.
export function readTenants(db: Database.Database, now: number): string[] {
  const rows = db.prepare(`SELECT g.tenant_id FROM gmail_accounts g WHERE g.read_granted = 1 AND g.status = 'active'
    AND EXISTS (SELECT 1 FROM outreach_messages m WHERE m.tenant_id = g.tenant_id AND m.status = 'sent' AND m.gmail_id IS NOT NULL AND m.sent_at >= ?) ORDER BY g.tenant_id`).all(now - READ_WINDOW_S) as { tenant_id: string }[]
  return rows.map(r => r.tenant_id).filter(t => hasReadConsent(db, t))
}

// bounce_coverage is 'checked' only when the sync says so (delivery notices outside the threads, #415); otherwise unknown.
export function recordSync(db: Database.Database, tenantId: string, r: { error?: string; bounce_coverage?: string }, now: number): void {
  const ok = r.error ? 0 : 1
  db.prepare(`INSERT INTO reply_sync_state (tenant_id, checked_at, ok, error, bounce_coverage, last_ok_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET checked_at = excluded.checked_at, ok = excluded.ok, error = excluded.error, bounce_coverage = excluded.bounce_coverage,
      last_ok_at = CASE WHEN excluded.ok = 1 THEN excluded.checked_at ELSE reply_sync_state.last_ok_at END`)
    .run(tenantId, now, ok, r.error ? r.error.slice(0, 60) : null, ok && r.bounce_coverage === 'checked' ? 'checked' : 'unknown', ok ? now : null)
}

export type Freshness = 'fresh' | 'stale' | 'failed' | 'unknown'
// How current a tenant's reply safety state is: 'failed' when the last sync errored (a partial sync is not fresh),
// 'stale' when the last success is older than FRESH_FOR_S, 'unknown' when it never ran.
export function replyFreshness(db: Database.Database, tenantId: string, now: number, maxAgeS = FRESH_FOR_S): Freshness {
  const s = db.prepare('SELECT ok, last_ok_at FROM reply_sync_state WHERE tenant_id = ?').get(tenantId) as { ok: number; last_ok_at: number | null } | undefined
  if (!s) return 'unknown'
  if (!s.ok) return 'failed'
  return s.last_ok_at !== null && now - s.last_ok_at <= maxAgeS ? 'fresh' : 'stale'
}

export interface ScheduleOptions { now?: number; keep?: () => Promise<void>; sync?: typeof syncReplies; onError?: (tenantId: string, e: unknown) => void }
// One scheduled pass: every read-authorized tenant is synced and checkpointed. Returns each tenant's result; a tenant whose
// sync threw is recorded failed with error 'sync_crashed'.
export async function scheduledReplySync(db: Database.Database, o: ScheduleOptions = {}): Promise<Map<string, SyncResult | { error: string }>> {
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const out = new Map<string, SyncResult | { error: string }>()
  for (const t of readTenants(db, now)) {
    await o.keep?.()
    let r: SyncResult | { error: string }
    try { r = await (o.sync ?? syncReplies)(db, t) } catch (e) { o.onError?.(t, e); r = { error: 'sync_crashed' } }
    recordSync(db, t, r, now)
    out.set(t, r)
  }
  return out
}
