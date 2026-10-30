// "First 5": the fast first scan of a new account. It runs the free, keyless sources only (news search, public job boards: no TinyFish, no paid web-search fallback, no credit enrichment) and the
// status route serves this view so the UI can show verified leads, live per-source progress and "finding more..." and NEVER an empty screen.
//   state: finding (still running) | ready (5 verified) | partial (1-4 verified, more can be found) | stopped_empty (finished with none: reason says why, distinct for failed / rejected / zero_match)
// Leads here are what the verifier passed (identity / quote / date / place), with no contact or fit claim beyond what is stored: fit_pct is null until a fit grade exists, a name is null until one is attached.
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import type { SourceProgress } from './progress.ts'
import type { ScanOutcome } from './scan-outcome.ts'

export const FIRST5_TARGET = 5
export type First5State = 'finding' | 'ready' | 'partial' | 'stopped_empty'
export type First5Reason = 'failed' | 'rejected' | 'zero_match' | 'none_extracted' | 'stopped' | 'unrecorded'
// event_date is when the EVENT happened (as the verifier read it); published_at is when the PAGE was published. They are different facts and are never substituted for one another: a request for a funding window is
// answered by the event date. Either may be null.
export interface First5Lead { id: string; company: string; name: string | null; signal: string; source_url: string; event_date: string | null; published_at: string | null; fit_pct: number | null; provisional: boolean }
export interface First5View {
  target: number; found: number; verified: number; enriching: boolean; next: { action: 'wider_search'; label: string } | null; state: First5State; finding_more: boolean; reason: First5Reason | null; message: string
  leads: First5Lead[]; sources: { source: string; state: SourceProgress['state']; status: SourceProgress['status']; note: string | null; candidates: number | null; accepted: number | null; review: number | null; rejected: number | null }[]
  failed_sources: string[]; can_continue: boolean   // can_continue: a normal full scan can be started to find the rest
}
type LeadRow = { id: string; name: string; company: string; signal: string; source_url: string; event_date: string | null; published_at: string | null; fit: number | null }

// Verifier-passed, not rejected by the user; best fit first, newest first. Scoped through the job's owner.
const VERIFIED_SQL = `SELECT l.id, l.name, l.company, l.signal, l.source_url, l.event_date, l.published_at, l.fit FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
    WHERE j.id = ? AND j.user_id = ? AND l.review_reason IS NULL AND l.quarantined_at IS NULL AND (l.fit IS NULL OR l.fit > 1)
    ORDER BY (l.fit IS NULL), l.fit DESC, l.created_at DESC, l.insert_seq LIMIT ?`
const toLead = (r: LeadRow): First5Lead => ({ id: r.id, company: r.company || r.name, name: r.company && r.name ? r.name : null, signal: r.signal, source_url: r.source_url, event_date: r.event_date ?? null, published_at: r.published_at ?? null, provisional: false,
  fit_pct: typeof r.fit === 'number' && r.fit >= 0 && r.fit <= 5 ? Math.round((r.fit / 5) * 100) : null })
export function verifiedLeads(db: Database.Database, userId: string, jobId: string, limit = FIRST5_TARGET): First5Lead[] {
  return (db.prepare(VERIFIED_SQL).all(jobId, userId, limit) as LeadRow[]).map(toLead)
}
const FIRST5_SQL = 'SELECT run_budget FROM scan_jobs WHERE id = ? AND user_id = ?'
const first5Budget = (r: { run_budget: string | null } | undefined) => { try { return !!r?.run_budget && (JSON.parse(r.run_budget) as { first5?: unknown }).first5 === true } catch { return false } }
export function isFirst5(db: Database.Database, userId: string, jobId: string): boolean {
  return first5Budget(db.prepare(FIRST5_SQL).get(jobId, userId) as { run_budget: string | null } | undefined)
}
// verifiedLeads and isFirst5 on the Db layer (SQLite or Postgres): the same queries and the same shaping.
export async function readVerifiedLeads(db: Db, userId: string, jobId: string, limit = FIRST5_TARGET): Promise<First5Lead[]> {
  return (await db.all<LeadRow>(VERIFIED_SQL, [jobId, userId, limit])).map(toLead)
}
export async function readIsFirst5(db: Db, userId: string, jobId: string): Promise<boolean> {
  return first5Budget(await db.get<{ run_budget: string | null }>(FIRST5_SQL, [jobId, userId]))
}
const REASON: Partial<Record<ScanOutcome['kind'], First5Reason>> = { failed: 'failed', review_only: 'rejected', all_dropped: 'rejected', zero_match: 'zero_match', none_extracted: 'none_extracted', stopped: 'stopped', unrecorded: 'unrecorded' }

export function first5Of(input: { status: string; leads: First5Lead[]; progress: SourceProgress[]; outcome: ScanOutcome }): First5View {
  const { status, progress, outcome } = input
  // 'enriching': the scan row is finished but the company-site lookups, fit grading and the sales-hiring check are still running, and that check can still HOLD a lead. The job is active: what is shown is
  // provisional, nothing is "verified" yet, no second scan is offered, and the view never turns terminal until the stage ends.
  const enriching = status === 'enriching', running = status === 'pending' || status === 'running' || enriching
  const leads = input.leads.slice(0, FIRST5_TARGET).map(l => ({ ...l, provisional: enriching })), found = leads.length, verified = enriching ? 0 : found
  const sources = progress.map(p => ({ source: p.source, state: p.state, status: p.status, note: p.note, candidates: p.candidates, accepted: p.accepted, review: p.review, rejected: p.rejected }))
  const failed_sources = progress.filter(p => p.status === 'failed').map(p => p.source)
  const base = { target: FIRST5_TARGET, found, verified, enriching, leads, sources, failed_sources }
  // finding_more is true ONLY while work is really active. A terminal result says what it is and offers a deliberate wider search: nothing continues in the background.
  const wider = { action: 'wider_search' as const, label: 'Search wider (a full scan, using your scan allowance)' }
  if (enriching) return { ...base, state: 'finding', finding_more: true, reason: null, can_continue: false, next: null, message: found > 0 ? `${found} found. Checking each one and looking up who to contact...` : 'Checking what was found...' }
  if (running) return { ...base, state: 'finding', finding_more: true, reason: null, can_continue: false, next: null, message: 'Searching the free sources for your first customers...' }
  if (verified >= FIRST5_TARGET) return { ...base, state: 'ready', finding_more: false, reason: null, can_continue: true, next: null, message: `We found ${verified} customers you can look at today.` }
  if (verified > 0) return { ...base, state: 'partial', finding_more: false, reason: null, can_continue: true, next: wider, message: `${verified} of ${FIRST5_TARGET} verified from the free sources. You can search wider for more.` }
  // Finished with nothing verified: say WHICH of the distinct reasons it was (a failed source, rejected candidates, or a clean zero), never a bare empty state.
  // A free-sources-only run stops (budget_stopped) when its sources gave nothing; if a source FAILED that is the reason to show, not the stop.
  if (outcome.kind === 'stopped' && failed_sources.length > 0) return { ...base, state: 'stopped_empty', finding_more: false, reason: 'failed', can_continue: true, next: wider, message: `Failed - ${failed_sources.join(', ')} had an error. You can search wider.` }
  const reason = REASON[outcome.kind] ?? 'unrecorded'
  return { ...base, state: 'stopped_empty', finding_more: false, reason, can_continue: true, next: wider, message: `${outcome.label}${outcome.detail ? `: ${outcome.detail}` : ''}. You can search wider.` }
}
