import type Database from 'better-sqlite3'
import { parseWindowDays, windowStatus } from '../scan/window.ts'
import { requiredGateHeld } from '../scan/held-state.ts'
import { uncheckableCause } from '../lead-state.ts'
import { timingProofGap } from '../scan/timing-proof.ts'
import { researchProofGap } from '../research/proof.ts'
// A legacy nearby-year verdict proves no event association. Human confirmation
// remains a user's review choice, not a machine freshness or consent verdict.
// The user's own recency window (#198) is a hard gate on top: a lead whose event date is not inside the window of the
// scan that found it (stale, undated, invalid or future) is research only. Ordinary source or identity review never
// lifts it; only a scan run with a window that covers the date does. An unreadable profile holds too.
export function currentnessHeld(db: Database.Database, tenant: string, lead: string, now: Date = new Date()): boolean {
 const row=db.prepare('SELECT l.human_confirmed_at,l.human_confirmed_from,l.review_reason,l.confidence,l.event_date,j.icp,j.query FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(lead,tenant) as {human_confirmed_at:number|null;human_confirmed_from:string|null;review_reason:string|null;confidence:number|null;event_date:string|null;icp:string|null;query:string|null}|undefined
 if (!row) return false
 if (windowHeld(row, now)) return true
 // Someone else's customer, a different place, a closed opening: research only, and confirming it does not change that (#352).
 if (uncheckableCause(row.review_reason) || uncheckableCause(row.human_confirmed_from)) return true
 if (requiredGateHeld(db, tenant, lead)) return true   // a failed REQUIRED gate survives lead / domain confirmation
 if (row.human_confirmed_at!==null || row.confidence===null) return false
 // A machine-verified lead with no human review is held unless its durable, versioned timing proof stands right now
 // (#377, lib/scan/timing-proof.ts): proven event day in the window, confirmed domain, named person and published route,
 // all still bound to the recorded proof. Model confidence alone never lifts this hold.
 // A research-verified lead (lib/research/proof.ts, MISSION v2): its event proven on the cited page by a literal quote and a second model, its
 // day stated there inside the window, a named person proven on their own page - all still bound to the lead as it is now. Fail closed.
 let timingStands=false
 try { timingStands=timingProofGap(db, tenant, lead, now)===null } catch { /* an unreadable proof store holds */ }
 if (timingStands) return false
 // read second, and it returns after one read for a lead the research proof never marked: the old engine's leads pay almost nothing
 try { if (researchProofGap(db, tenant, lead, now)===null) return false } catch { /* an unreadable research record never lifts the hold */ }
 return true
}

// Read alone for the page: a window hold survives the user's own review, so the page must not clear it optimistically.
export function leadWindowHeld(db: Database.Database, tenant: string, lead: string, now: Date = new Date()): boolean {
 const row=db.prepare('SELECT l.event_date,j.icp,j.query FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(lead,tenant) as {event_date:string|null;icp:string|null;query:string|null}|undefined
 return !!row && windowHeld(row, now)
}

// Same range normalizeIcp accepts. Anything else stored (0, negative, fraction, string, object, NaN) is corrupt data,
// never a waiver of the user's window.
const validStoredWindow = (w: unknown): w is number => typeof w === 'number' && Number.isInteger(w) && w >= 1 && w <= 365

// Exported (pure) for reads on the async Db layer, e.g. a campaign page (lib/outreach/campaign-detail.ts, #683): same verdict, no second copy.
export function windowHeld(row: { event_date: string | null; icp: string | null; query: string | null }, now: Date): boolean {
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
