// Adaptive discovery driven by ACTIONABLE yield (#381): after a first batch, diagnose where candidates were lost (extraction, fit, timing, identity, contact), pick the
// next genuinely different source/query within explicit budgets, never repeat a query that already failed or came back empty, and stop with an honest reason.
// The constraints (request, profile, geography, windows) are fixed; widening is a separate user choice and is never done here. Every round still passes the normal
// verifier and gates. Pure planner + a small persistence layer on the Db layer (SQLite and Postgres).
import type { Db } from '../db/client.ts'
import type Database from 'better-sqlite3'
import { sanitizeQueries, withGeography } from '../search/tinyfish.ts'

export function migrateRounds(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS discovery_rounds (
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    source TEXT NOT NULL,
    query_key TEXT NOT NULL,
    query TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','empty','failed')),
    new_pages INTEGER NOT NULL DEFAULT 0,
    actionable_after INTEGER NOT NULL DEFAULT 0,
    why TEXT,
    at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (job_id, round, source, query_key)
  );`)
}

export type Loss = 'extraction' | 'fit' | 'timing' | 'identity' | 'contact'
export interface Funnel { candidates: number; verified: number; fit_ok: number; timed: number; identified: number; actionable: number }   // each stage's survivors, non-increasing
export interface RoundRecord { round: number; source: string; query: string; outcome: 'ok' | 'empty' | 'failed'; new_pages: number; actionable_after: number }
export interface Budget { target: number; maxRounds: number; maxSearches: number; maxPages: number; maxMs: number }
export const DEFAULT_BUDGET: Budget = { target: 5, maxRounds: 3, maxSearches: 8, maxPages: 16, maxMs: 90_000 }
export type StopReason = 'target_met' | 'budget_exhausted' | 'time_exhausted' | 'max_rounds' | 'coverage_exhausted' | 'no_new_queries'
export type Decision =
  | { action: 'search'; source: string; queries: string[]; diagnosis: Loss; why: string }
  | { action: 'enrich'; diagnosis: Loss; why: string }                    // the loss is after discovery (identity / contact): more searching would not fix it
  | { action: 'stop'; reason: StopReason; detail: string }

export const queryKey = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const SOURCES = ['search:tinyfish', 'adapter:jobboards', 'search:news', 'adapter:sec'] as const

// Where the funnel loses most (first stage with a drop that leaves nothing usable). Candidates that were found but not actionable are lost to the earliest stage that cut them.
export function diagnose(f: Funnel): Loss {
  if (f.candidates === 0 || f.verified === 0) return 'extraction'
  if (f.fit_ok === 0) return 'fit'
  if (f.timed === 0) return 'timing'
  if (f.identified === 0) return 'identity'
  return 'contact'
}

export interface PlanInput {
  query: string; icp: { signals: string[]; where: string[] }; funnel: Funnel; history: RoundRecord[]
  spent: { searches: number; pages: number; ms: number }; budget?: Partial<Budget>
  failedKeys?: Set<string>          // query keys that failed or came back empty earlier for this tenant: never billed again
  sources?: string[]                // sources available to this run (default: all)
  now?: Date
}

export function nextRound(i: PlanInput): Decision {
  const b = { ...DEFAULT_BUDGET, ...i.budget }
  const rounds = new Set(i.history.map(h => h.round)).size
  if (i.funnel.actionable >= b.target) return { action: 'stop', reason: 'target_met', detail: `${i.funnel.actionable} actionable lead${i.funnel.actionable === 1 ? '' : 's'} (target ${b.target}).` }
  // Limits are stated as LIMITS: hitting one is not evidence the market has nothing more.
  if (i.spent.ms >= b.maxMs) return { action: 'stop', reason: 'time_exhausted', detail: `Stopped at the ${Math.round(b.maxMs / 1000)}s time limit; more may exist (this is not market exhaustion).` }
  if (i.spent.searches >= b.maxSearches || i.spent.pages >= b.maxPages) return { action: 'stop', reason: 'budget_exhausted', detail: `Stopped at the search/page budget (${i.spent.searches}/${b.maxSearches} searches, ${i.spent.pages}/${b.maxPages} pages); more may exist (this is not market exhaustion).` }
  if (rounds >= b.maxRounds) return { action: 'stop', reason: 'max_rounds', detail: `Stopped after ${b.maxRounds} rounds; more may exist (this is not market exhaustion).` }
  const loss = diagnose(i.funnel)
  if (loss === 'identity' || loss === 'contact') return { action: 'enrich', diagnosis: loss, why: loss === 'identity' ? 'Candidates exist but none has a confirmed company identity: confirm identities, do not search for more.' : 'Candidates are identified but none has a reachable right-role contact: look up contacts, do not search for more.' }
  // Coverage: several different sources already tried and the latest rounds found nothing unseen -> the reachable market looks exhausted for THESE constraints.
  const tried = new Set(i.history.map(h => h.source))
  const lastTwo = [...new Set(i.history.map(h => h.round))].sort((a, c) => c - a).slice(0, 2)
  const quiet = lastTwo.length === 2 && i.history.filter(h => lastTwo.includes(h.round)).every(h => h.new_pages === 0)
  const available = (i.sources ?? [...SOURCES])
  if (tried.size >= Math.min(3, available.length) && quiet) return { action: 'stop', reason: 'coverage_exhausted', detail: `${tried.size} different sources were tried and the last two rounds found no unseen pages; the constraints, not the budget, ran out.` }
  const failed = new Set([...(i.failedKeys ?? []), ...i.history.filter(h => h.outcome !== 'ok').map(h => queryKey(h.query))])
  const seen = new Set([...failed, ...i.history.map(h => queryKey(h.query))])
  // The next source is one not tried yet (genuinely different); once all were tried, the same source with queries not seen.
  const source = available.find(s => !tried.has(s)) ?? available[0]
  const signals = i.icp.signals.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length >= 8)
  const queries = withGeography(sanitizeQueries(signals, i.query, i.now ?? new Date()), i.icp.where).filter(q => !seen.has(queryKey(q))).slice(0, Math.max(0, Math.min(3, b.maxSearches - i.spent.searches)))
  if (queries.length === 0) return { action: 'stop', reason: 'no_new_queries', detail: 'Every query this profile can make was already tried or failed earlier; widening is a choice for you, not something dazl does on its own.' }
  return { action: 'search', source, queries, diagnosis: loss, why: loss === 'extraction' ? 'The first batch produced no usable candidates: trying a different source and queries.' : loss === 'fit' ? 'Candidates were found but none fit the profile: searching the profile signals again from another source.' : 'Candidates fit but none has a dated event: searching for dated coverage from another source.' }
}

// ---- persistence (Db layer: SQLite and Postgres) ----
export async function recordRound(db: Db, jobId: string, r: RoundRecord & { why?: string | null }, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.run('INSERT INTO discovery_rounds (job_id, round, source, query_key, query, outcome, new_pages, actionable_after, why, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (job_id, round, source, query_key) DO NOTHING',
    [jobId, r.round, r.source, queryKey(r.query), r.query.slice(0, 300), r.outcome, r.new_pages, r.actionable_after, r.why ?? null, now])
}
export async function loadRounds(db: Db, tenantId: string, jobId: string): Promise<RoundRecord[]> {
  const rows = await db.all<{ round: number; source: string; query: string; outcome: RoundRecord['outcome']; new_pages: number; actionable_after: number }>(
    'SELECT r.round, r.source, r.query, r.outcome, r.new_pages, r.actionable_after FROM discovery_rounds r JOIN scan_jobs j ON j.id = r.job_id WHERE r.job_id = ? AND j.user_id = ? ORDER BY r.round, r.source, r.query_key', [jobId, tenantId])
  return rows.map(r => ({ ...r, round: Number(r.round), new_pages: Number(r.new_pages), actionable_after: Number(r.actionable_after) }))
}
// Query keys this tenant already paid for that failed or came back empty since `sinceS`, across its jobs.
export async function failedQueryKeys(db: Db, tenantId: string, sinceS: number): Promise<Set<string>> {
  const rows = await db.all<{ query_key: string }>("SELECT DISTINCT r.query_key FROM discovery_rounds r JOIN scan_jobs j ON j.id = r.job_id WHERE j.user_id = ? AND r.outcome IN ('failed', 'empty') AND r.at >= ?", [tenantId, sinceS])
  return new Set(rows.map(r => r.query_key))
}
