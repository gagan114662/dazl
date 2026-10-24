import type Database from 'better-sqlite3'
import type { Evidence } from '../sources/types.ts'

// Per-scan record of what the TinyFish collector actually did, so a low-yield scan can be explained from data
// instead of guessed. Counting rules (the whole point):
//  - "attempted" means a request really went to the provider. A local cap, local rate limit or disabled switch
//    sent nothing, so it is "not attempted", never a failure and never zero hits.
//  - A failed or unreachable call has UNKNOWN hits/pages: those counts stay null. 0 means the provider answered
//    and returned nothing.
//  - hits are the valid https results kept after dedupe-free normalisation (max 10 per query), not the provider's
//    unfiltered payload.
type Code = string
export type SearchEvent = { kind: 'search'; query: string; attempted: boolean; outcome: Code; hits: string[] | null }
export type FetchEvent = { kind: 'fetch'; requested: number; attempted: boolean; outcome: Code; pages: number | null }

export class SearchTrace {
  events: (SearchEvent | FetchEvent)[] = []
  search(e: Omit<SearchEvent, 'kind'>): void { this.events.push({ kind: 'search', ...e }) }
  fetch(e: Omit<FetchEvent, 'kind'>): void { this.events.push({ kind: 'fetch', ...e }) }
}

export interface SourceStats {
  queries: string[]
  query_source?: 'model' | 'fallback' | null
  searches_attempted: number
  searches_ok: number
  searches_failed: Record<string, number>
  searches_not_attempted: Record<string, number>
  hits_raw: number | null
  hits_unique_urls: number | null
  // true: every search ran and answered, so hits_raw / hits_unique_urls are totals. false: some search failed or never
  // ran, so they are lower bounds (known subtotals). null: no search answered, nothing to bound.
  hits_complete: boolean | null
  fetch_complete: boolean | null
  fetch_requested: number | null
  fetch_outcome: string | null
  fetch_pages_with_text: number | null
  per_query?: { query: string; outcome: string; hits: number | null; new_urls: number | null }[]
  distinct_hosts?: number | null
  urls_not_fetched?: number | null
  extracted_candidates?: number | null
  model_requested?: string | null
  model_served?: string | null
  model_calls?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  evidence_items?: number | null
  evidence_with_page_text?: number | null
  evidence_snippet_only?: number | null
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }
const norm = (u: string) => u.replace(/\/$/, '')

export function summarizeTrace(t: SearchTrace): SourceStats {
  const s: SourceStats = { queries: [], query_source: null, searches_attempted: 0, searches_ok: 0, searches_failed: {}, searches_not_attempted: {}, hits_raw: null, hits_unique_urls: null, hits_complete: null, fetch_complete: null, fetch_requested: null, fetch_outcome: null, fetch_pages_with_text: null, per_query: [], distinct_hosts: null, urls_not_fetched: null }
  const urls = new Set<string>(); let raw = 0; let fetchBad = false; let fetchOk = false
  for (const e of t.events) {
    if (e.kind === 'search') {
      s.queries.push(e.query)
      if (!e.attempted) { bump(s.searches_not_attempted, e.outcome); s.per_query!.push({ query: e.query, outcome: `not_attempted:${e.outcome}`, hits: null, new_urls: null }); continue }
      s.searches_attempted++
      if (e.outcome === 'ok' && e.hits) { s.searches_ok++; raw += e.hits.length; const before = urls.size; for (const u of e.hits) urls.add(norm(u)); s.per_query!.push({ query: e.query, outcome: 'ok', hits: e.hits.length, new_urls: urls.size - before }) } else { bump(s.searches_failed, e.outcome); s.per_query!.push({ query: e.query, outcome: e.outcome, hits: null, new_urls: null }) }
    } else {
      s.fetch_requested = (s.fetch_requested ?? 0) + e.requested
      if (!e.attempted) { s.fetch_outcome = s.fetch_outcome ?? e.outcome; fetchBad = true; continue }
      s.fetch_outcome = e.outcome
      if (e.outcome === 'ok' && e.pages !== null) { s.fetch_pages_with_text = (s.fetch_pages_with_text ?? 0) + e.pages; fetchOk = true } else fetchBad = true
    }
  }
  if (s.searches_ok > 0) {
    s.hits_raw = raw; s.hits_unique_urls = urls.size
    s.hits_complete = Object.keys(s.searches_failed).length === 0 && Object.keys(s.searches_not_attempted).length === 0
    s.distinct_hosts = new Set([...urls].map(u => { try { return new URL(u).hostname.toLowerCase() } catch { return u } })).size
    if (s.fetch_requested !== null) s.urls_not_fetched = Math.max(0, urls.size - s.fetch_requested)
  }
  if (fetchOk) s.fetch_complete = !fetchBad
  return s
}

// How much of the model's evidence came from fetched page text and how much only from search snippets.
export function evidenceSplit(items: Evidence[], pages: { url: string }[]): { evidence_items: number; evidence_with_page_text: number; evidence_snippet_only: number } {
  const have = new Set(pages.map(p => norm(p.url)))
  const withPage = items.filter(i => have.has(norm(i.url))).length
  return { evidence_items: items.length, evidence_with_page_text: withPage, evidence_snippet_only: items.length - withPage }
}

// Persistence is OFF unless the operator sets DAZL_SOURCE_STATS=1. Off means: no table is created, nothing is
// written, no behaviour changes. Turning it on creates one new table (CREATE TABLE IF NOT EXISTS, all columns
// nullable, no change to existing tables).
export const sourceStatsEnabled = (env: Record<string, string | undefined> = process.env) => env.DAZL_SOURCE_STATS === '1'

export function migrateSourceStats(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scan_source_stats (
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    collector TEXT NOT NULL,
    queries TEXT CHECK (queries IS NULL OR length(queries) <= 2000),
    query_source TEXT CHECK (query_source IS NULL OR query_source IN ('model','fallback')),
    searches_attempted INTEGER,
    searches_ok INTEGER,
    searches_failed TEXT CHECK (searches_failed IS NULL OR length(searches_failed) <= 200),
    searches_not_attempted TEXT CHECK (searches_not_attempted IS NULL OR length(searches_not_attempted) <= 200),
    hits_raw INTEGER,
    hits_unique_urls INTEGER,
    hits_complete INTEGER CHECK (hits_complete IS NULL OR hits_complete IN (0,1)),
    fetch_complete INTEGER CHECK (fetch_complete IS NULL OR fetch_complete IN (0,1)),
    fetch_requested INTEGER,
    fetch_outcome TEXT CHECK (fetch_outcome IS NULL OR length(fetch_outcome) <= 40),
    fetch_pages_with_text INTEGER,
    per_query TEXT CHECK (per_query IS NULL OR length(per_query) <= 4000),
    distinct_hosts INTEGER,
    urls_not_fetched INTEGER,
    extracted_candidates INTEGER,
    model_requested TEXT CHECK (model_requested IS NULL OR length(model_requested) <= 100),
    model_served TEXT CHECK (model_served IS NULL OR length(model_served) <= 100),
    model_calls INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    evidence_items INTEGER,
    evidence_with_page_text INTEGER,
    evidence_snippet_only INTEGER,
    PRIMARY KEY (job_id, attempt, collector)
  )`)
}

// Best effort: a failure here must never fail or change the scan. Returns whether a row was written.
export function writeSourceStats(db: Database.Database, jobId: string, attempt: number, collector: string, s: SourceStats, env: Record<string, string | undefined> = process.env): boolean {
  if (!sourceStatsEnabled(env)) return false
  try {
    migrateSourceStats(db)
    const q = JSON.stringify(s.queries); const pq = JSON.stringify(s.per_query ?? []); const j = (o: Record<string, number>) => JSON.stringify(o)
    db.prepare(`INSERT OR REPLACE INTO scan_source_stats (job_id,attempt,collector,queries,query_source,searches_attempted,searches_ok,searches_failed,searches_not_attempted,hits_raw,hits_unique_urls,hits_complete,fetch_complete,fetch_requested,fetch_outcome,fetch_pages_with_text,per_query,distinct_hosts,urls_not_fetched,extracted_candidates,model_requested,model_served,model_calls,input_tokens,output_tokens,evidence_items,evidence_with_page_text,evidence_snippet_only)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId, attempt, collector, q.length <= 2000 ? q : null, s.query_source ?? null, s.searches_attempted, s.searches_ok, j(s.searches_failed), j(s.searches_not_attempted), s.hits_raw, s.hits_unique_urls, s.hits_complete === null ? null : s.hits_complete ? 1 : 0, s.fetch_complete === null ? null : s.fetch_complete ? 1 : 0, s.fetch_requested, s.fetch_outcome, s.fetch_pages_with_text, pq.length <= 4000 ? pq : null, s.distinct_hosts ?? null, s.urls_not_fetched ?? null, s.extracted_candidates ?? null, s.model_requested?.slice(0, 100) ?? null, s.model_served?.slice(0, 100) ?? null, s.model_calls ?? null, s.input_tokens ?? null, s.output_tokens ?? null, s.evidence_items ?? null, s.evidence_with_page_text ?? null, s.evidence_snippet_only ?? null)
    return true
  } catch { return false }
}

// null = the table does not exist (nothing was ever recorded). [] = table exists, no rows for this owner's job.
export function sourceStats(db: Database.Database, tenantId: string, jobId: string) {
  try {
    const rows = db.prepare(`SELECT s.* FROM scan_source_stats s JOIN scan_jobs j ON j.id=s.job_id WHERE j.user_id=? AND j.id=? ORDER BY s.attempt,s.collector`).all(tenantId, jobId) as Record<string, unknown>[]
    const parse = (v: unknown) => { try { return typeof v === 'string' ? JSON.parse(v) : null } catch { return null } }
    return rows.map(r => ({ ...r, queries: parse(r.queries), per_query: parse(r.per_query), searches_failed: parse(r.searches_failed), searches_not_attempted: parse(r.searches_not_attempted) })) as unknown as (Record<string, unknown> & { queries: string[] | null; query_source: string | null; hits_raw: number | null })[]
  } catch { return null }
}
