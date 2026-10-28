// One bounded, tenant-readable record of what a scan attempt did at every stage, written with the job (never changes a verdict):
// the queries sent, every search-result URL with its date, whether it was selected for fetching and whether TinyFish returned
// text, the verifier's own fetch outcome per cited URL, every extracted candidate with its verification fate and reason, the
// funnel counts, rejection reasons and model usage. Absent fields stay null ("not recorded"), never a fabricated zero.
import type Database from 'better-sqlite3'
import { canonicalUrl } from './evidence-origin.ts'
import { canonicalUrl as trackingFreeUrl } from '../search/tinyfish.ts'

const ownFetchOf = (m: Map<string, string> | undefined, url: string): string | null => m?.get(trackingFreeUrl(url) ?? url) ?? m?.get(canonicalUrl(url) ?? url) ?? m?.get(url) ?? null

export interface CandidateAudit { key: string; company: string; url: string; outcome: 'passed' | 'review' | 'dropped'; reason: string | null; evidence_origin?: string | null }
export interface UrlRecord { url: string; hit_date: string | null; walled: boolean; selected: boolean; tinyfish_text_chars: number | null; own_fetch: string | null }
export interface ReportParts {
  queries?: string[]; query_source?: string | null
  search?: { attempted: number | null; ok: number | null; hits_raw: number | null; hits_unique_urls: number | null; hits_complete: boolean | null }
  urls?: UrlRecord[]
  evidence?: { items: number | null; with_page_text: number | null; snippet_only: number | null }
  extracted_candidates?: number | null
  extraction?: import('./extraction-note.ts').ExtractionNote | null
  audit?: CandidateAudit[]
  ownFetch?: Map<string, string>
  dropCounts?: Record<string, number>
  model?: { requests_recorded: number; requests_with_reported_tokens: number; input_tokens: number | null; output_tokens: number | null; tokens_complete: boolean }
  observed?: { search: boolean; extraction: boolean; verification: boolean }
}
export const MAX_URLS = 120, MAX_CANDIDATES = 80, MAX_REPORT_CHARS = 120_000
// Table-wide retention: a report older than this is deleted the next time any report is written (reports also go with their job via ON DELETE CASCADE).
export const RUN_REPORT_RETENTION_DAYS = 90
const cut = (s: string, n: number) => s.length > n ? s.slice(0, n) : s

export function migrateRunReport(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scan_run_report (
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    report TEXT NOT NULL CHECK (length(report) <= ${MAX_REPORT_CHARS}),
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (job_id, attempt)
  )`)
}

export interface FinalRow { key: string; review_reason?: string | null }
// Builds the report from the parts gathered during the attempt and the FINAL saved rows (so window gate, dedup and caps are
// reflected): a candidate's fate is `verified`, `review:<reason>` or `dropped:<reason>` (every duplicate, contradiction, source cap and exclusion is its own decision).
export function buildRunReport(p: ReportParts, verified: FinalRow[] | null, review: FinalRow[] | null, attempt: number, now = Date.now()) {
  const vKeys = new Set((verified ?? []).map(r => r.key)); const rMap = new Map((review ?? []).map(r => [r.key, r.review_reason ?? 'review']))
  const audit = p.audit ?? []
  const fates = audit.map(a => {
    // A terminal 'dropped' decision recorded for THIS occurrence stands; only passed / review entries are matched against the final rows.
    const fate = a.outcome === 'dropped' ? `dropped:${a.reason ?? 'unknown'}` : vKeys.has(a.key) ? 'verified' : rMap.has(a.key) ? `review:${rMap.get(a.key)}` : verified === null ? `not_finished:${a.reason ?? a.outcome}` : `dropped:${a.reason ?? 'after_verification'}`
    return { company: cut(a.company, 120), url: cut(a.url, 300), fate, own_fetch: ownFetchOf(p.ownFetch, a.url), evidence_origin: a.evidence_origin ?? null }
  })
  const count = (pre: string) => fates.filter(f => f.fate === pre || f.fate.startsWith(`${pre}:`)).length
  const reasons = (pre: string) => { const o: Record<string, number> = {}; for (const f of fates) if (f.fate.startsWith(`${pre}:`)) { const r = f.fate.slice(pre.length + 1); o[r] = (o[r] ?? 0) + 1 } return o }
  // Measured zero is not unobserved: a stage that never ran reports null, never 0.
  const observed = { search: p.search != null, extraction: p.extracted_candidates !== undefined && p.extracted_candidates !== null, verification: p.dropCounts !== undefined }
  const measured = observed.verification
  return {
    v: 1, attempt, generated_at: new Date(now).toISOString(),
    observed,
    coverage: [
      'urls: TinyFish search hits only. News-adapter, public-adapter and provider-fallback candidates have no search-result URL entry.',
      'candidates: every candidate the verifier saw, plus login-wall and self-description holds. Candidates a model-search fallback returns are included once they reach the verifier.',
      'model: requests dazl sent through the job provider before this report was written (all stages that ran, research calls included, which report no tokens). Steps after the scan finishes (buyer-fit) and profile generation are NOT included. Never a bill.',
      'a stage that did not run is null, not 0',
    ],
    queries: (p.queries ?? []).slice(0, 12).map(q => cut(q, 300)), query_source: p.query_source ?? null,
    search: p.search ?? null,
    urls: (p.urls ?? []).slice(0, MAX_URLS).map(u => ({ ...u, url: cut(u.url, 300), own_fetch: u.own_fetch ?? ownFetchOf(p.ownFetch, u.url) })),
    evidence: p.evidence ?? null, extracted_candidates: p.extracted_candidates ?? null, extraction: p.extraction ?? null,
    candidates: fates.slice(0, MAX_CANDIDATES),
    funnel: { candidates: p.extracted_candidates ?? (measured ? fates.length : null), verified: measured ? count('verified') : null, needs_review: measured ? count('review') : null, dropped: measured ? count('dropped') : null, review_reasons: reasons('review'), drop_reasons: reasons('dropped'), verifier_drop_counts: p.dropCounts ?? null },
    model: p.model ?? null,
    truncated: { urls: Math.max(0, (p.urls?.length ?? 0) - MAX_URLS), candidates: Math.max(0, fates.length - MAX_CANDIDATES) },
  }
}

export function writeRunReport(db: Database.Database, jobId: string, attempt: number, report: unknown, env: Record<string, string | undefined> = process.env): boolean {
  if (env.DAZL_RUN_REPORT === '0') return false
  try {
    migrateRunReport(db)
    try { db.prepare('DELETE FROM scan_run_report WHERE created_at < ?').run(Math.floor(Date.now() / 1000) - RUN_REPORT_RETENTION_DAYS * 86_400) } catch { /* retention is best effort */ }
    let s = JSON.stringify(report)
    if (s.length > MAX_REPORT_CHARS) { const r = report as { urls?: unknown[]; candidates?: unknown[] }; s = JSON.stringify({ ...r, urls: (r.urls ?? []).slice(0, 30), candidates: (r.candidates ?? []).slice(0, 30), truncated_for_size: true }) }
    if (s.length > MAX_REPORT_CHARS) return false
    db.prepare('INSERT OR REPLACE INTO scan_run_report (job_id, attempt, report) VALUES (?, ?, ?)').run(jobId, attempt, s)
    return true
  } catch { return false }
}

// Owner-scoped read. null = never recorded for this job (table absent or no row) - "not recorded", not zero.
export function runReportFor(db: Database.Database, tenantId: string, jobId: string): unknown[] | null {
  try {
    const rows = db.prepare('SELECT r.attempt, r.report FROM scan_run_report r JOIN scan_jobs j ON j.id = r.job_id WHERE j.id = ? AND j.user_id = ? ORDER BY r.attempt').all(jobId, tenantId) as { attempt: number; report: string }[]
    return rows.length ? rows.map(r => JSON.parse(r.report)) : null
  } catch { return null }
}
