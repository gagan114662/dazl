import type Database from 'better-sqlite3'
import { parseWindowDays, windowStatus } from '../scan/window.ts'
import { readRequiredGateHeld, requiredGateHeld } from '../scan/held-state.ts'
import type { Db } from '../db/client.ts'
// A legacy nearby-year verdict proves no event association. Human confirmation
// remains a user's review choice, not a machine freshness or consent verdict.
// The user's own recency window (#198) is a hard gate on top: a lead whose event date is not inside the window of the
// scan that found it (stale, undated, invalid or future) is research only. Ordinary source or identity review never
// lifts it; only a scan run with a window that covers the date does. An unreadable profile holds too.
const CURRENTNESS_SQL='SELECT l.human_confirmed_at,l.confidence,l.event_date,j.icp,j.query FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?'
type CurrentnessRow={human_confirmed_at:number|null;confidence:number|null;event_date:string|null;icp:string|null;query:string|null}
const WINDOW_SQL='SELECT l.event_date,j.icp,j.query FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?'
type WindowRow={event_date:string|null;icp:string|null;query:string|null}
export function currentnessHeld(db: Database.Database, tenant: string, lead: string, now: Date = new Date()): boolean {
 const row=db.prepare(CURRENTNESS_SQL).get(lead,tenant) as CurrentnessRow|undefined
 if (!row) return false
 if (windowHeld(row, now)) return true
 if (requiredGateHeld(db, tenant, lead)) return true   // a failed REQUIRED gate survives lead / domain confirmation
 return row.human_confirmed_at===null && row.confidence!==null
}

// Read alone for the page: a window hold survives the user's own review, so the page must not clear it optimistically.
export function leadWindowHeld(db: Database.Database, tenant: string, lead: string, now: Date = new Date()): boolean {
 const row=db.prepare(WINDOW_SQL).get(lead,tenant) as WindowRow|undefined
 return !!row && windowHeld(row, now)
}

// currentnessHeld and leadWindowHeld on the Db layer (SQLite or Postgres): the same reads and the same decisions.
export async function readCurrentnessHeld(db: Db, tenant: string, lead: string, now: Date = new Date()): Promise<boolean> {
 const row=await db.get<CurrentnessRow>(CURRENTNESS_SQL,[lead,tenant])
 if (!row) return false
 if (windowHeld(row, now)) return true
 if (await readRequiredGateHeld(db, tenant, lead)) return true
 return row.human_confirmed_at===null && row.confidence!==null
}
export async function readLeadWindowHeld(db: Db, tenant: string, lead: string, now: Date = new Date()): Promise<boolean> {
 const row=await db.get<WindowRow>(WINDOW_SQL,[lead,tenant])
 return !!row && windowHeld(row, now)
}

// Same range normalizeIcp accepts. Anything else stored (0, negative, fraction, string, object, NaN) is corrupt data,
// never a waiver of the user's window.
const validStoredWindow = (w: unknown): w is number => typeof w === 'number' && Number.isInteger(w) && w >= 1 && w <= 365

function windowHeld(row: { event_date: string | null; icp: string | null; query: string | null }, now: Date): boolean {
 let days: number | null = null
 let corrupt = false
 if (row.icp) {
  try {
   const w = (JSON.parse(row.icp) as { window_days?: unknown } | null)?.window_days
   if (validStoredWindow(w)) days = w
   else if (w !== undefined && w !== null) corrupt = true // a window was saved but is unusable
  } catch { return true }
 }
 // Invalid saved window: recover the constraint from the original request text; if that has none, hold (fail closed).
 days ??= parseWindowDays(row.query ?? '')
 if (days === null && corrupt) return true
 return windowStatus(row.event_date, days, now) !== 'inside'
}
