import type Database from 'better-sqlite3'
import { parseWindowDays, windowStatus } from '../scan/window.ts'
// A legacy nearby-year verdict proves no event association. Human confirmation
// remains a user's review choice, not a machine freshness or consent verdict.
// The user's own recency window (#198) is a hard gate on top: a lead whose event date is not inside the window of the
// scan that found it (stale, undated, invalid or future) is research only. Ordinary source or identity review never
// lifts it; only a scan run with a window that covers the date does. An unreadable profile holds too.
export function currentnessHeld(db: Database.Database, tenant: string, lead: string, now: Date = new Date()): boolean {
 const row=db.prepare('SELECT l.human_confirmed_at,l.confidence,l.event_date,j.icp,j.query FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(lead,tenant) as {human_confirmed_at:number|null;confidence:number|null;event_date:string|null;icp:string|null;query:string|null}|undefined
 if (!row) return false
 if (windowHeld(row, now)) return true
 return row.human_confirmed_at===null && row.confidence!==null
}

// Read alone for the page: a window hold survives the user's own review, so the page must not clear it optimistically.
export function leadWindowHeld(db: Database.Database, tenant: string, lead: string, now: Date = new Date()): boolean {
 const row=db.prepare('SELECT l.event_date,j.icp,j.query FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(lead,tenant) as {event_date:string|null;icp:string|null;query:string|null}|undefined
 return !!row && windowHeld(row, now)
}

function windowHeld(row: { event_date: string | null; icp: string | null; query: string | null }, now: Date): boolean {
 let days: number | null = null
 if (row.icp) {
  try { const w = (JSON.parse(row.icp) as { window_days?: unknown })?.window_days; if (typeof w === 'number') days = w } catch { return true }
 }
 days ??= parseWindowDays(row.query ?? '')
 return windowStatus(row.event_date, days, now) !== 'inside'
}
