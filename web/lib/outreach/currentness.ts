import type { Db } from '../db/client.ts'
import type Database from 'better-sqlite3'
import { signalStale } from '../discover/card.ts'
import { hasDiscoveryEventDate } from '../discover/timing.ts'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { companyFirstJobWindow, parseWindowDays, windowStatus } from '../scan/window.ts'
import { requiredGateHeld } from '../scan/held-state.ts'
import { uncheckableCause } from '../lead-state.ts'
import { timingProofGap, timingProofGapDb } from '../scan/timing-proof.ts'
// A legacy nearby-year verdict proves no event association. Human confirmation
// remains a user's review choice, not a machine freshness or consent verdict.
// The user's own recency window (#198) is a hard gate on top: a lead whose event date is not inside the window of the
// scan that found it (stale, undated, invalid or future) is research only. Ordinary source or identity review never
// lifts it; only a scan run with a window that covers the date does. An unreadable profile holds too.
export function currentnessHeld(db: Database.Database, tenant: string, lead: string, now: Date = new Date(), gateHeld?: () => boolean): boolean {
 const row=db.prepare('SELECT l.source_kind,l.human_confirmed_at,l.human_confirmed_from,l.review_reason,l.confidence,l.event_date,l.timing_note,j.icp,j.query,j.run_budget FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(lead,tenant) as CurrentnessRow | undefined
 return currentnessHeldFromRow(row, now, gateHeld ?? (() => requiredGateHeld(db, tenant, lead) !== null),
   () => timingProofGap(db, tenant, lead, now) !== null)
}

type CurrentnessRow = { source_kind:string|null;timing_note:string|null;human_confirmed_at:number|null;human_confirmed_from:string|null;review_reason:string|null;confidence:number|null;event_date:string|null;icp:string|null;query:string|null;run_budget:string|null }

export function currentnessRowsForJob(db: Database.Database, tenant: string, jobId: string, ids: readonly string[]) {
 const rows = db.prepare(`SELECT l.id, l.source_kind, l.human_confirmed_at, l.human_confirmed_from, l.review_reason,
   l.confidence, l.event_date, l.timing_note, j.icp, j.query, j.run_budget
   FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
   WHERE j.user_id = ? AND j.id = ? AND l.id IN (SELECT value FROM json_each(?))`)
   .all(tenant, jobId, JSON.stringify(ids)) as (CurrentnessRow & { id: string })[]
 return new Map(rows.map(row => [row.id, row]))
}

export function currentnessHeldFromRow(
 row: CurrentnessRow | undefined, now: Date, gateHeld: () => boolean, proofHeld: () => boolean,
): boolean {
 if (!row) return false
 // Someone else's customer, a different place, a closed opening: research only, and confirming it does not change that (#352).
 if (uncheckableCause(row.review_reason) || uncheckableCause(row.human_confirmed_from)) return true
 // Discovery dates from the search index cannot authorize email, even on an existing draft.
 if (row.source_kind === 'discover') return !hasDiscoveryEventDate(row) || signalStale(row.event_date, now)
 if (windowHeld(row, now)) return true
 if (gateHeld()) return true   // a failed REQUIRED gate survives lead / domain confirmation
 // Marked jobs can use only their durable machine proof. Even a review
 // confirmation written by an older release cannot lift this hold or switch
 // the candidate to the legacy research proof fallback.
 if (hasCompanyFirstBudget(row.run_budget)) {
  try { return proofHeld() } catch { return true }
 }
 if (row.human_confirmed_at!==null || row.confidence===null) return false
 // A machine-verified lead with no human review is held unless its durable, versioned timing proof stands right now
 // (#377, lib/scan/timing-proof.ts): proven event day in the window, confirmed domain, named person and published route,
 // all still bound to the recorded proof. Model confidence alone never lifts this hold.
 // (The research engine's proof, the only other way out of this hold, was deleted with that engine: #1393. It ran only with LEAD_ENGINE=research.)
 try { return proofHeld() } catch { return true }   // an unreadable proof store holds
}

// Read alone for the page: a window hold survives the user's own review, so the page must not clear it optimistically.
export function leadWindowHeld(db: Database.Database, tenant: string, lead: string, now: Date = new Date()): boolean {
 const row=db.prepare('SELECT l.event_date,j.icp,j.query,j.run_budget FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(lead,tenant) as {event_date:string|null;icp:string|null;query:string|null;run_budget:string|null}|undefined
 return !!row && windowHeld(row, now)
}

// Same range normalizeIcp accepts. Anything else stored (0, negative, fraction, string, object, NaN) is corrupt data,
// never a waiver of the user's window.
const validStoredWindow = (w: unknown): w is number => typeof w === 'number' && Number.isInteger(w) && w >= 1 && w <= 365

// Exported (pure) for reads on the async Db layer, e.g. a campaign page (lib/outreach/campaign-detail.ts, #683): same verdict, no second copy.
export function windowHeld(row: { event_date: string | null; icp: string | null; query: string | null; run_budget?: string | null }, now: Date): boolean {
 const companyFirst = companyFirstJobWindow(row)
 if (companyFirst) return companyFirst.days === null || windowStatus(row.event_date, companyFirst.days, now) !== 'inside'
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

// Only the marked CSV projection needs this reader. The caller supplies
// the canonical batched required-gate decision for this exact owned job.
export async function markedCurrentnessHeldDb(db:Db,tenant:string,job:string,lead:string,now:Date,requiredHeld:ReadonlySet<string>):Promise<boolean>{
 if(db.kind!=='sqlite'||requiredHeld.has(lead))return true
 const row=await db.get<{review_reason:string|null;human_confirmed_from:string|null;event_date:string|null;icp:string|null;query:string|null;run_budget:string|null}>(
   'SELECT l.review_reason,l.human_confirmed_from,l.event_date,j.icp,j.query,j.run_budget FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.id=? AND j.user_id=?',
   [lead,job,tenant])
 return !row||!hasCompanyFirstBudget(row.run_budget)||windowHeld(row,now)||!!uncheckableCause(row.review_reason)||
   !!uncheckableCause(row.human_confirmed_from)||(await timingProofGapDb(db,tenant,lead,now))!==null
}
