// "First 5": the fast first scan of a new account. It runs the free, keyless sources only (news search, public job boards: no TinyFish, no paid web-search fallback, no credit enrichment) and the
// status route serves this view so the UI can show verified leads, live per-source progress and "finding more..." and NEVER an empty screen.
//   state: finding (still running) | ready (5 verified) | partial (1-4 verified, more can be found) | stopped_empty (finished with none: reason says why, distinct for failed / rejected / zero_match)
// Leads here are what the verifier passed (identity / quote / date / place), with no contact or fit claim beyond what is stored: fit_pct is null until a fit grade exists, a name is null until one is attached.
import type Database from 'better-sqlite3'
import type { SourceProgress } from './progress.ts'
import type { ScanOutcome } from './scan-outcome.ts'

export const FIRST5_TARGET = 5
export type First5State = 'finding' | 'ready' | 'partial' | 'stopped_empty'
export type First5Reason = 'failed' | 'rejected' | 'zero_match' | 'none_extracted' | 'stopped' | 'unrecorded'
export interface First5Lead { id: string; company: string; name: string | null; signal: string; source_url: string; date: string | null; fit_pct: number | null }
export interface First5View {
  target: number; verified: number; state: First5State; finding_more: boolean; reason: First5Reason | null; message: string
  leads: First5Lead[]; sources: { source: string; state: SourceProgress['state']; status: SourceProgress['status']; note: string | null; candidates: number | null; accepted: number | null; review: number | null; rejected: number | null }[]
  failed_sources: string[]; can_continue: boolean   // can_continue: a normal full scan can be started to find the rest
}
type LeadRow = { id: string; name: string; company: string; signal: string; source_url: string; event_date: string | null; published_at: string | null; fit: number | null }

// Verifier-passed, not rejected by the user; best fit first, newest first. Scoped through the job's owner.
export function verifiedLeads(db: Database.Database, userId: string, jobId: string, limit = FIRST5_TARGET): First5Lead[] {
  const rows = db.prepare(`SELECT l.id, l.name, l.company, l.signal, l.source_url, l.event_date, l.published_at, l.fit FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
    WHERE j.id = ? AND j.user_id = ? AND l.review_reason IS NULL AND l.quarantined_at IS NULL AND (l.fit IS NULL OR l.fit > 1)
    ORDER BY (l.fit IS NULL), l.fit DESC, l.created_at DESC, l.insert_seq LIMIT ?`).all(jobId, userId, limit) as LeadRow[]
  return rows.map(r => ({ id: r.id, company: r.company || r.name, name: r.company && r.name ? r.name : null, signal: r.signal, source_url: r.source_url, date: r.event_date ?? r.published_at ?? null,
    fit_pct: typeof r.fit === 'number' && r.fit >= 0 && r.fit <= 5 ? Math.round((r.fit / 5) * 100) : null }))
}
export function isFirst5(db: Database.Database, userId: string, jobId: string): boolean {
  const r = db.prepare('SELECT run_budget FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, userId) as { run_budget: string | null } | undefined
  try { return !!r?.run_budget && (JSON.parse(r.run_budget) as { first5?: unknown }).first5 === true } catch { return false }
}
const REASON: Partial<Record<ScanOutcome['kind'], First5Reason>> = { failed: 'failed', review_only: 'rejected', all_dropped: 'rejected', zero_match: 'zero_match', none_extracted: 'none_extracted', stopped: 'stopped', unrecorded: 'unrecorded' }

export function first5Of(input: { status: string; leads: First5Lead[]; progress: SourceProgress[]; outcome: ScanOutcome }): First5View {
  const { status, progress, outcome } = input
  const leads = input.leads.slice(0, FIRST5_TARGET), verified = leads.length
  const running = status === 'pending' || status === 'running'
  const sources = progress.map(p => ({ source: p.source, state: p.state, status: p.status, note: p.note, candidates: p.candidates, accepted: p.accepted, review: p.review, rejected: p.rejected }))
  const failed_sources = progress.filter(p => p.status === 'failed').map(p => p.source)
  const base = { target: FIRST5_TARGET, verified, leads, sources, failed_sources }
  if (running) return { ...base, state: 'finding', finding_more: true, reason: null, can_continue: false, message: verified > 0 ? `${verified} found so far, finding more...` : 'Searching the free sources for your first customers...' }
  if (verified >= FIRST5_TARGET) return { ...base, state: 'ready', finding_more: false, reason: null, can_continue: true, message: `We found ${verified} customers you can look at today.` }
  if (verified > 0) return { ...base, state: 'partial', finding_more: true, reason: null, can_continue: true, message: `${verified} verified so far. Finding more...` }
  // Finished with nothing verified: say WHICH of the distinct reasons it was (a failed source, rejected candidates, or a clean zero), never a bare empty state.
  // A free-sources-only run stops (budget_stopped) when its sources gave nothing; if a source FAILED that is the reason to show, not the stop.
  if (outcome.kind === 'stopped' && failed_sources.length > 0) return { ...base, state: 'stopped_empty', finding_more: true, reason: 'failed', can_continue: true, message: `Failed - ${failed_sources.join(', ')} had an error. Finding more with a wider search...` }
  const reason = REASON[outcome.kind] ?? 'unrecorded'
  return { ...base, state: 'stopped_empty', finding_more: true, reason, can_continue: true, message: `${outcome.label}${outcome.detail ? `: ${outcome.detail}` : ''}. Finding more with a wider search...` }
}
