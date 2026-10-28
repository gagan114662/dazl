// Live per-source progress and the four honest ways a scan can end, derived only from what the job recorded (scan_source_runs rows, the run report). Pure functions; the status
// route serves the result so the UX can poll it while a scan runs.
//   per source:  { source, status, candidates, accepted, review, rejected }   null = not known yet (never a fabricated zero)
//   outcome:     failed (which source), rejected (counts per reason), zero-match (the sources returned nothing), or yielded N leads (see scan-outcome.ts)
export type SourceStatus = 'running' | 'ok' | 'empty' | 'failed' | 'skipped' | 'unavailable'   // unavailable: the source gave nothing usable (no results, or switched off) - NOT proof that it failed
export type SourceState = 'queued' | 'running' | 'done' | 'failed'
export interface SourceProgress { source: string; state: SourceState; status: SourceStatus; candidates: number | null; accepted: number | null; review: number | null; rejected: number | null }
export interface SourceRunRow { collector?: unknown; status?: unknown; evidence_count?: unknown; candidate_count?: unknown; verified_count?: unknown; review_count?: unknown }

const FAILED = /^(?:error|timeout|failed|auth|quota|rate_limited|upstream)/i   // 'unavailable' is deliberately not here: the runner also records it for a search that returned no results or a source that is off
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function sourceStatusOf(raw: string, jobRunning: boolean): SourceStatus {
  if (raw === 'started') return jobRunning ? 'running' : 'failed'   // a source that never reported by the end of the scan did not complete
  if (FAILED.test(raw)) return 'failed'
  if (/^skipped/i.test(raw)) return 'skipped'
  if (raw === 'unavailable') return 'unavailable'
  if (raw === 'empty') return 'empty'
  return 'ok'
}

// The four states the UI shows. A source only gets a row once it starts, so 'queued' means a row that says so; a source with no row yet is simply not listed (never invented).
export const stateOf = (raw: string, status: SourceStatus): SourceState => (/^(?:queued|pending)$/i.test(raw) ? 'queued' : status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'done')

export function progressOf(rows: SourceRunRow[], jobStatus: string): SourceProgress[] {
  const running = jobStatus === 'running' || jobStatus === 'pending'
  return rows.map(r => {
    const candidates = num(r.candidate_count), accepted = num(r.verified_count), review = num(r.review_count)
    const rejected = candidates !== null && accepted !== null && review !== null ? Math.max(0, candidates - accepted - review) : null
    const raw = String(r.status ?? ''), status = sourceStatusOf(raw, running)
    return { source: String(r.collector ?? ''), state: stateOf(raw, status), status, candidates, accepted, review, rejected }
  }).filter(p => p.source)
}

// Inputs for scanOutcome() from the run report and the source rows: which sources failed, the per-reason counts of everything rejected, and how many search results came back.
export function outcomeInputs(report: unknown, rows: SourceRunRow[], jobStatus: string): { failed_sources: string[]; reject_reasons: Record<string, number> | null; search_hits: number | null } {
  const rep = (report && typeof report === 'object' ? report : {}) as { funnel?: { review_reasons?: Record<string, number>; drop_reasons?: Record<string, number> }; search?: { hits_unique_urls?: number | null; hits_raw?: number | null; ok?: number | null; attempted?: number | null } | null }
  const failed = progressOf(rows, jobStatus).filter(p => p.status === 'failed').map(p => p.source)
  const search = rep.search ?? null
  // a search whose every attempt failed is a failed source, not an empty result
  if (search && typeof search.attempted === 'number' && search.attempted > 0 && search.ok === 0 && !failed.includes('search:tinyfish')) failed.push('search:tinyfish')
  const reasons: Record<string, number> = {}
  for (const [k, v] of Object.entries(rep.funnel?.review_reasons ?? {})) if (typeof v === 'number' && v > 0) reasons[`review:${k}`] = v
  for (const [k, v] of Object.entries(rep.funnel?.drop_reasons ?? {})) if (typeof v === 'number' && v > 0) reasons[`dropped:${k}`] = v
  const hits = typeof search?.hits_unique_urls === 'number' ? search.hits_unique_urls : typeof search?.hits_raw === 'number' ? search.hits_raw : null
  return { failed_sources: failed, reject_reasons: Object.keys(reasons).length ? reasons : null, search_hits: hits }
}
