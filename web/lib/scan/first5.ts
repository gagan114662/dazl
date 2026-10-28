// "First 5": the fast first scan of a new account. It runs the free, keyless sources only (news search, public job boards: no TinyFish, no paid web-search fallback, no credit enrichment) and the
// status route serves this view so the UI can show verified leads, live per-source progress and "finding more..." and NEVER an empty screen.
//   state: finding (still running) | ready (5 verified) | partial (1-4 verified, more can be found) | stopped_empty (finished with none: reason says why, distinct for failed / rejected / zero_match)
// Leads here are what the verifier passed (identity / quote / date / place), with no contact or fit claim beyond what is stored: fit_pct is null until a fit grade exists, a name is null until one is attached.
import type Database from 'better-sqlite3'
import type { SourceProgress } from './progress.ts'
import type { ScanOutcome } from './scan-outcome.ts'
import { contactsFromEnrichments, roleContradicted, type ContactEnrichment } from '../people/rank.ts'
import { personMatchesRole, whoOf } from './actionable.ts'

export const FIRST5_TARGET = 5
export type First5State = 'finding' | 'ready' | 'partial' | 'stopped_empty'
export type First5Reason = 'failed' | 'rejected' | 'zero_match' | 'none_extracted' | 'stopped' | 'unrecorded'
// A named decision-maker only from what the lead's own enrichment stored (the company's own team / about page, listed with that title): the title must fit the requested buyer role (or be founder-level)
// and must not be contradicted (past, retired, assistant-to). No address is built from a name and no profile search is run (those are not free).
export interface First5Person { name: string; title: string; source_url: string; basis: string }
export type PersonState = 'found' | 'listed_not_buyer' | 'none_published' | 'looking'
export interface First5Lead { id: string; company: string; name: string | null; signal: string; source_url: string; date: string | null; fit_pct: number | null; person: First5Person | null; person_state: PersonState; provisional: boolean }
export interface First5View {
  target: number; found: number; verified: number; enriching: boolean; state: First5State; finding_more: boolean; reason: First5Reason | null; message: string
  leads: First5Lead[]; sources: { source: string; state: SourceProgress['state']; status: SourceProgress['status']; note: string | null; candidates: number | null; accepted: number | null; review: number | null; rejected: number | null }[]
  failed_sources: string[]; can_continue: boolean   // can_continue: a normal full scan can be started to find the rest
}
type LeadRow = { id: string; name: string; company: string; signal: string; source_url: string; event_date: string | null; published_at: string | null; fit: number | null }

// Verifier-passed, not rejected by the user; best fit first, newest first. Scoped through the job's owner.
export function verifiedLeads(db: Database.Database, userId: string, jobId: string, limit = FIRST5_TARGET): First5Lead[] {
  const rows = db.prepare(`SELECT l.id, l.name, l.company, l.signal, l.source_url, l.event_date, l.published_at, l.fit FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
    WHERE j.id = ? AND j.user_id = ? AND l.review_reason IS NULL AND l.quarantined_at IS NULL AND (l.fit IS NULL OR l.fit > 1)
    ORDER BY (l.fit IS NULL), l.fit DESC, l.created_at DESC, l.insert_seq LIMIT ?`).all(jobId, userId, limit) as LeadRow[]
  const who = whoOf((db.prepare('SELECT icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, userId) as { icp: string | null } | undefined)?.icp) || 'founder'
  return rows.map(r => {
    let enr: ContactEnrichment[] = []
    try { enr = db.prepare("SELECT kind, value, label, source_url, connector FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND kind IN ('person', 'contact') ORDER BY insert_seq").all(r.id, userId) as ContactEnrichment[] } catch { /* the table may predate this deploy */ }
    const listed = contactsFromEnrichments(enr, who)
    const pick = listed.find(c => c.title && !roleContradicted(c.title, who) && personMatchesRole(`${c.name}, ${c.title}`, who))
    return { id: r.id, company: r.company || r.name, name: r.company && r.name ? r.name : null, signal: r.signal, source_url: r.source_url, date: r.event_date ?? r.published_at ?? null,
      fit_pct: typeof r.fit === 'number' && r.fit >= 0 && r.fit <= 5 ? Math.round((r.fit / 5) * 100) : null, provisional: false,
      person: pick ? { name: pick.name, title: pick.title!, source_url: pick.source ?? pick.linkedin ?? '', basis: pick.connector === 'sitecrawl' ? 'listed with this title on the company\'s own website' : `found by ${pick.connector}` } : null,
      person_state: (pick ? 'found' : listed.length > 0 ? 'listed_not_buyer' : 'none_published') as PersonState }
  })
}
export function isFirst5(db: Database.Database, userId: string, jobId: string): boolean {
  const r = db.prepare('SELECT run_budget FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, userId) as { run_budget: string | null } | undefined
  try { return !!r?.run_budget && (JSON.parse(r.run_budget) as { first5?: unknown }).first5 === true } catch { return false }
}
const REASON: Partial<Record<ScanOutcome['kind'], First5Reason>> = { failed: 'failed', review_only: 'rejected', all_dropped: 'rejected', zero_match: 'zero_match', none_extracted: 'none_extracted', stopped: 'stopped', unrecorded: 'unrecorded' }

export function first5Of(input: { status: string; leads: First5Lead[]; progress: SourceProgress[]; outcome: ScanOutcome }): First5View {
  const { status, progress, outcome } = input
  // 'enriching': the scan finished but the company-site people lookup and the sales-hiring check are still running, and that check can still hold a lead. Leads shown now are provisional, never final.
  const enriching = status === 'enriching', running = status === 'pending' || status === 'running' || enriching
  const leads = input.leads.slice(0, FIRST5_TARGET).map(l => enriching ? { ...l, provisional: true, person_state: l.person_state === 'none_published' ? 'looking' as PersonState : l.person_state } : l), found = leads.length, verified = enriching ? 0 : found
  const sources = progress.map(p => ({ source: p.source, state: p.state, status: p.status, note: p.note, candidates: p.candidates, accepted: p.accepted, review: p.review, rejected: p.rejected }))
  const failed_sources = progress.filter(p => p.status === 'failed').map(p => p.source)
  const base = { target: FIRST5_TARGET, found, verified, enriching, leads, sources, failed_sources }
  if (enriching) return { ...base, state: 'finding', finding_more: true, reason: null, can_continue: false, message: found > 0 ? `${found} found. Checking each one and looking up who to contact...` : 'Checking what was found...' }
  if (running) return { ...base, state: 'finding', finding_more: true, reason: null, can_continue: false, message: 'Searching the free sources for your first customers...' }
  if (verified >= FIRST5_TARGET) return { ...base, state: 'ready', finding_more: false, reason: null, can_continue: true, message: `We found ${verified} customers you can look at today.` }
  if (verified > 0) return { ...base, state: 'partial', finding_more: true, reason: null, can_continue: true, message: `${verified} verified so far. Finding more...` }
  // Finished with nothing verified: say WHICH of the distinct reasons it was (a failed source, rejected candidates, or a clean zero), never a bare empty state.
  // A free-sources-only run stops (budget_stopped) when its sources gave nothing; if a source FAILED that is the reason to show, not the stop.
  if (outcome.kind === 'stopped' && failed_sources.length > 0) return { ...base, state: 'stopped_empty', finding_more: true, reason: 'failed', can_continue: true, message: `Failed - ${failed_sources.join(', ')} had an error. Finding more with a wider search...` }
  const reason = REASON[outcome.kind] ?? 'unrecorded'
  return { ...base, state: 'stopped_empty', finding_more: true, reason, can_continue: true, message: `${outcome.label}${outcome.detail ? `: ${outcome.detail}` : ''}. Finding more with a wider search...` }
}
