// One bounded, tenant-readable record of what a scan attempt did at every stage, written with the job (never changes a verdict):
// the queries sent, every search-result URL with its date, whether it was selected for fetching and whether TinyFish returned
// text, the verifier's own fetch outcome per cited URL, every extracted candidate with its verification fate and reason, the
// funnel counts, rejection reasons and model usage. Absent fields stay null ("not recorded"), never a fabricated zero.
import type { ParseDropCounts } from '../discover/parse-drop-counts.ts'
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { canonicalUrl } from './evidence-origin.ts'
import { canonicalUrl as trackingFreeUrl } from '../search/tinyfish.ts'

const ownFetchOf = (m: Map<string, string> | undefined, url: string): string | null => m?.get(trackingFreeUrl(url) ?? url) ?? m?.get(canonicalUrl(url) ?? url) ?? m?.get(url) ?? null

export interface CandidateAudit { key: string; company: string; url: string; outcome: 'passed' | 'review' | 'dropped'; reason: string | null; evidence_origin?: string | null }
export interface UrlRecord { url: string; hit_date: string | null; walled: boolean; selected: boolean; tinyfish_text_chars: number | null; own_fetch: string | null }
export type JudgeReplyClass = 'supports' | 'contradicts' | 'explicit_unclear' | 'prefixed_unclear' | 'blank' | 'unrecognized' | 'unavailable'
export type JudgeReplyCounts = Partial<Record<JudgeReplyClass, number>>
export interface ReportParts {
  // Refs #1122: company-first funding-pass candidates dropped for their source (internal only; never shown in the product)
  funding_source_rejects?: Partial<Record<import('../company-first/funding-source.ts').FundingSourceReason, number>>
  // #1082: units the platform's fair share of the operator search budget left out (the run's results are thinner)
  capacity?: { searches: number; fetches: number }
  queries?: string[]; query_source?: string | null
  search?: { attempted: number | null; ok: number | null; hits_raw: number | null; hits_unique_urls: number | null; hits_complete: boolean | null }
  urls?: UrlRecord[]
  evidence?: { items: number | null; with_page_text: number | null; snippet_only: number | null }
  extracted_candidates?: number | null
  extraction?: import('./extraction-note.ts').ExtractionNote | null
  audit?: CandidateAudit[]
  ownFetch?: Map<string, string>
  judge_replies?: JudgeReplyCounts // aggregate closed enum only; no model text or passage
  dropCounts?: Record<string, number>
  model?: { requests_recorded: number; requests_with_reported_tokens: number; input_tokens: number | null; output_tokens: number | null; tokens_complete: boolean }
  observed?: { search: boolean; extraction: boolean; verification: boolean }
  // The free news search's request truth (lib/search/news.ts): per-class failure counts, the non-200 statuses seen and the
  // per-query outcome classes. Counts and status codes only - never payloads, URLs or response bodies.
  news?: { attempted: number; failed: number; limited: number; malformed: number; failure_classes: Record<string, number>; http_statuses: Record<string, number>; query_classes: Record<string, number>; retried?: number; gave_up?: boolean } | null   // #1157: one retry after a backoff; gave_up = the retry failed too, so the remaining queries were not sent
  // Native Anthropic Web Search has aggregate billed usage, not a per-result token breakdown.
  native_web_search?: { estimated_usd: number; actual_usd: number | null; prior_settled_usd?: number; usage_incomplete?: true; counted_prompt_tokens: number; assumed_result_tokens: number; assumed_tool_overhead_tokens: number; reported_input_tokens: number | null; reported_cache_read_tokens?: number; reported_cache_write_5m_tokens?: number; reported_cache_write_1h_tokens?: number; reported_output_tokens: number | null; searches: number | null; max_searches: number; max_output_tokens: number; expected_model: string; inference_geo_diagnostic?: 'not_available' | 'unrecognized_price_neutral'; evidence_diagnostic?: import('../llm/claude-web-search.ts').ClaudeSearchEvidenceDiagnostic & { publisher_attempted: number; publisher_lookahead_attempted?: number; ats_boards_cited?: number; ats_board_postings?: number; publisher_returned: number; publisher_failures: Partial<Record<import('./fetch-page.ts').FetchFail['fail'] | 'other', number>>; publisher_usable: number; evidence_items: number }; rejected_usage?: import('../llm/claude-web-search-estimate.ts').ClaudeUsageSnapshot; estimate_exceeded: boolean | null; soft_estimate: true }
  // Why the scan stopped when it did: the bounded stop code written as the job error, and the exact spend-refusal reason
  // when one caused it (spend-guard.ts). The code alone must never have to carry a reason it does not mean. When an
  // earlier refusal names the stop but a later refusal also happened (e.g. the trailing research_unbounded), the later
  // reason is preserved too - the record keeps BOTH, never only the code's priority winner. When finish()'s
  // authoritative terminal overrides (accounting_failed / accounting_uncertain / provider rejection) replace the
  // staged classification, code is the FINAL job error and the staged one is kept as superseded_stop_code.
  stop?: { code: string; spend_refusal_reason: string | null; superseded_refusal_reason?: string | null; superseded_stop_code?: string | null; room?: { left_usd: number; needed_usd: number } | null } | null
  // #1205 (review F2): a source that was not used, why, and what to change, in the same plain words as its progress row ("'Europe' is a region. ...").
  source_skips?: { source: string; status: string; reason: string }[]
  // The Claude discovery lane's own account of its run (#1579, production job 1569fa9c: 0 leads and nothing saved to say why):
  // how it stopped, the budget it ran with, what it returned and the one sentence it gives when it found fewer leads than asked.
  discover?: { stop: string; note: string | null; budget: 'full' | 'small' | 'smallest'; searches: number; requests: number; passes: number; returned: number; shown: number; usd: number | null; parse_counts?: ParseDropCounts } | null
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
    ...(p.judge_replies ? { judge_replies: p.judge_replies } : {}),
    news: p.news ?? null, stop: p.stop ?? null,
    ...(p.native_web_search ? { native_web_search: p.native_web_search } : {}),
    source_skips: (p.source_skips ?? []).slice(0, 20).map(x => ({ source: cut(x.source, 80), status: cut(x.status, 120), reason: cut(x.reason, 300) })),
    capacity: p.capacity ?? null,
    ...(p.discover ? { discover: { ...p.discover, stop: cut(p.discover.stop, 40), note: p.discover.note === null ? null : cut(p.discover.note, 300) } } : {}),
    ...(p.funding_source_rejects ? { funding_source_rejects: p.funding_source_rejects } : {}),
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

// A gate that runs AFTER the report was written (the sales-hiring gate) moves leads from verified to review. The saved report must show the final outcome:
// the candidate's fate becomes `review:<reason>` and the funnel is recounted, so no surface reports a held lead as verified. Best effort; never throws.
export function reconcileRunReport(db: Database.Database, jobId: string, attempt: number, demotions: { company: string; url: string; reason: string }[]): boolean {
  if (demotions.length === 0) return false
  try {
    const row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ? AND attempt = ?').get(jobId, attempt) as { report: string } | undefined
    if (!row) return false
    const r = JSON.parse(row.report) as { candidates?: { company: string; url: string; fate: string }[]; funnel?: Record<string, unknown> }
    if (!Array.isArray(r.candidates)) return false
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')
    let changed = 0
    for (const d of demotions) {
      const c = r.candidates.find(x => x.fate === 'verified' && norm(x.company) === norm(d.company) && x.url === d.url.slice(0, 300)) ?? r.candidates.find(x => x.fate === 'verified' && norm(x.company) === norm(d.company))
      if (c) { c.fate = `review:${d.reason}`; changed++ }
    }
    if (!changed) return false
    const f = r.funnel ?? {}
    if (typeof f.verified === 'number') f.verified = Math.max(0, f.verified - changed)
    if (typeof f.needs_review === 'number') f.needs_review = f.needs_review + changed
    const reasons = (f.review_reasons && typeof f.review_reasons === 'object' ? f.review_reasons : {}) as Record<string, number>
    for (const d of demotions) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1
    f.review_reasons = reasons; r.funnel = f
    ;(r as Record<string, unknown>).final_gate = 'sales_hiring'
    db.prepare('UPDATE scan_run_report SET report = ? WHERE job_id = ? AND attempt = ?').run(JSON.stringify(r), jobId, attempt)
    return true
  } catch { return false }
}

const RUN_REPORT_SQL = 'SELECT r.attempt, r.report FROM scan_run_report r JOIN scan_jobs j ON j.id = r.job_id WHERE j.id = ? AND j.user_id = ? ORDER BY r.attempt'

// Owner-scoped read. null = never recorded for this job (table absent or no row) - "not recorded", not zero.
export function runReportFor(db: Database.Database, tenantId: string, jobId: string): unknown[] | null {
  try {
    const rows = db.prepare(RUN_REPORT_SQL).all(jobId, tenantId) as { attempt: number; report: string }[]
    return rows.length ? rows.map(r => JSON.parse(r.report)) : null
  } catch { return null }
}

// Keep the authoritative database attempt separate from the legacy JSON payload.
export async function readRunReportRows(db: Db, tenantId: string, jobId: string): Promise<{ attempt: number; report: unknown }[] | null> {
  try {
    const rows = await db.all<{ attempt: number; report: string }>(RUN_REPORT_SQL, [jobId, tenantId])
    return rows.length ? rows.map(r => ({ attempt: r.attempt, report: JSON.parse(r.report) as unknown })) : null
  } catch { return null }
}

// Legacy payload order and missing/unreadable semantics are unchanged.
export async function readRunReport(db: Db, tenantId: string, jobId: string): Promise<unknown[] | null> {
  return (await readRunReportRows(db, tenantId, jobId))?.map(r => r.report) ?? null
}
