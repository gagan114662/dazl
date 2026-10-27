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
  audit?: CandidateAudit[]
  ownFetch?: Map<string, string>
  dropCounts?: Record<string, number>
  stage?: string
  sources?: { collector: string; status: string; evidence: number | null }[]
  model?: { calls: number | null; input_tokens: number | null; output_tokens: number | null }
}
export const MAX_URLS = 120, MAX_CANDIDATES = 80, MAX_REPORT_CHARS = 120_000
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
// reflected): a candidate's fate is `verified`, `review:<reason>` or `dropped:<reason>`.
export function buildRunReport(p: ReportParts, verified: FinalRow[] | null, review: FinalRow[] | null, attempt: number, now = Date.now(), inProgress = false) {
  const vKeys = new Set((verified ?? []).map(r => r.key)); const rMap = new Map((review ?? []).map(r => [r.key, r.review_reason ?? 'review']))
  const audit = p.audit ?? []
  const fates = audit.map(a => {
    const fate = vKeys.has(a.key) ? 'verified' : rMap.has(a.key) ? `review:${rMap.get(a.key)}` : a.outcome === 'dropped' ? `dropped:${a.reason ?? 'unknown'}` : verified === null ? `not_finished:${a.reason ?? a.outcome}` : `dropped:${a.reason ?? 'duplicate_company_or_source_cap'}`
    return { company: cut(a.company, 120), url: cut(a.url, 300), fate, own_fetch: ownFetchOf(p.ownFetch, a.url), evidence_origin: a.evidence_origin ?? null }
  })
  const count = (pre: string) => fates.filter(f => f.fate === pre || f.fate.startsWith(`${pre}:`)).length
  const reasons = (pre: string) => { const o: Record<string, number> = {}; for (const f of fates) if (f.fate.startsWith(`${pre}:`)) { const r = f.fate.slice(pre.length + 1); o[r] = (o[r] ?? 0) + 1 } return o }
  return {
    v: 1, attempt, generated_at: new Date(now).toISOString(), in_progress: inProgress, stage: inProgress ? (p.stage ?? 'running') : 'finished', sources: p.sources ?? [],
    queries: (p.queries ?? []).slice(0, 12).map(q => cut(q, 300)), query_source: p.query_source ?? null,
    search: p.search ?? null,
    urls: (p.urls ?? []).slice(0, MAX_URLS).map(u => ({ ...u, url: cut(u.url, 300), own_fetch: u.own_fetch ?? ownFetchOf(p.ownFetch, u.url) })),
    evidence: p.evidence ?? null, extracted_candidates: p.extracted_candidates ?? null,
    candidates: fates.slice(0, MAX_CANDIDATES),
    funnel: { candidates: fates.length, verified: count('verified'), needs_review: count('review'), dropped: count('dropped'), review_reasons: reasons('review'), drop_reasons: reasons('dropped'), verifier_drop_counts: p.dropCounts ?? null },
    model: p.model ?? null,
    truncated: { urls: Math.max(0, (p.urls?.length ?? 0) - MAX_URLS), candidates: Math.max(0, fates.length - MAX_CANDIDATES) },
  }
}

export function writeRunReport(db: Database.Database, jobId: string, attempt: number, report: unknown, env: Record<string, string | undefined> = process.env): boolean {
  if (env.DAZL_RUN_REPORT === '0') return false
  try {
    migrateRunReport(db)
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

// What a UI can show while a scan runs (and after): derived only from the stored report. Counts the scan has not reached yet are null.
export interface Progress { stage: string; in_progress: boolean; sources_tried: { collector: string; status: string; candidates_or_evidence: number | null }[]; queries_sent: number; results_found: number | null; pages_selected: number; pages_with_text: number; candidates_found: number | null; checks_done: number; rejections_by_reason: Record<string, number> }
export function progressOf(report: Record<string, any> | null | undefined): Progress | null {
  if (!report || typeof report !== 'object') return null
  const urls = Array.isArray(report.urls) ? report.urls : []
  const f = report.funnel ?? {}
  const rej: Record<string, number> = {}
  for (const [k, n] of Object.entries(f.review_reasons ?? {})) rej[`review: ${k}`] = n as number
  for (const [k, n] of Object.entries(f.drop_reasons ?? {})) rej[k] = n as number
  const cands = Array.isArray(report.candidates) ? report.candidates : []
  // Mid-scan the final fates are not known yet; the verifier's own drop counts are, as soon as verification has run.
  if (report.in_progress) for (const [k, n] of Object.entries(report.funnel?.verifier_drop_counts ?? {})) rej[k] = n as number
  return { stage: String(report.stage ?? 'finished'), in_progress: !!report.in_progress,
    sources_tried: (report.sources ?? []).map((s: any) => ({ collector: s.collector, status: s.status, candidates_or_evidence: s.evidence ?? null })),
    queries_sent: Array.isArray(report.queries) ? report.queries.length : 0, results_found: report.search?.hits_unique_urls ?? null,
    pages_selected: urls.filter((u: any) => u.selected).length, pages_with_text: urls.filter((u: any) => u.tinyfish_text_chars).length,
    candidates_found: report.extracted_candidates ?? (cands.length || null), checks_done: cands.filter((c: any) => !String(c.fate).startsWith('not_finished')).length, rejections_by_reason: rej }
}
