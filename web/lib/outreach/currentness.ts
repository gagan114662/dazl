import type Database from 'better-sqlite3'
// A legacy nearby-year verdict proves no event association. Human confirmation
// remains a user's review choice, not a machine freshness or consent verdict.
export function currentnessHeld(db: Database.Database, tenant: string, lead: string): boolean {
 const row=db.prepare('SELECT l.human_confirmed_at,l.confidence FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(lead,tenant) as {human_confirmed_at:number|null;confidence:number|null}|undefined
 return !!row && row.human_confirmed_at===null && row.confidence!==null
}
