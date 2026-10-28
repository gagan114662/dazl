// Live per-source progress and the four honest ways a scan can end, derived only from what the job recorded (scan_source_runs rows, the run report). Pure functions; the status
// route serves the result so the UX can poll it while a scan runs.
//   per source:  { source, status, candidates, accepted, review, rejected }   null = not known yet (never a fabricated zero)
//   outcome:     failed (which source), rejected (counts per reason), zero-match (the sources returned nothing), or yielded N leads (see scan-outcome.ts)
export type SourceStatus = 'running' | 'ok' | 'empty' | 'failed' | 'skipped' | 'unavailable' | 'partial' | 'no_candidates'   // no_candidates: it returned evidence but none of it was extracted as a candidate (not "found nothing"); partial: it answered, but some of its requests or entries failed - never ok, never an empty result; unavailable: the source gave nothing usable (no results, or switched off) - NOT proof that it failed
export type SourceState = 'queued' | 'running' | 'done' | 'failed'
export interface SourceProgress { source: string; state: SourceState; status: SourceStatus; note: string | null; candidates: number | null; accepted: number | null; review: number | null; rejected: number | null }
export interface SourceRunRow { collector?: unknown; status?: unknown; evidence_count?: unknown; candidate_count?: unknown; verified_count?: unknown; review_count?: unknown }

const FAILED = /^(?:error|timeout|failed|auth|quota|rate_limited|upstream)/i   // 'unavailable' is deliberately not here: the runner also records it for a search that returned no results or a source that is off
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function sourceStatusOf(raw: string, jobRunning: boolean): SourceStatus {
  if (raw === 'started') return jobRunning ? 'running' : 'failed'   // a source that never reported by the end of the scan did not complete
  if (FAILED.test(raw)) return 'failed'
  if (/^skipped/i.test(raw)) return 'skipped'
  if (raw === 'unavailable') return 'unavailable'
  if (/^partial/i.test(raw)) return 'partial'
  if (raw === 'no_candidates') return 'no_candidates'
  if (raw === 'empty') return 'empty'
  return 'ok'
}

// The four states the UI shows. A source only gets a row once it starts, so 'queued' means a row that says so; a source with no row yet is simply not listed (never invented).
export const stateOf = (raw: string, status: SourceStatus): SourceState => (/^(?:queued|pending)$/i.test(raw) ? 'queued' : status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'done')

// "partial:1_of_3" -> "1 of 3 requests failed"; "partial:malformed" / a bare "partial" -> some of it could not be read.
export function partialNote(raw: string): string | null {
  const m = /^partial:(\d+)_of_(\d+)/i.exec(raw)
  return m ? `${m[1]} of ${m[2]} requests failed` : /^partial/i.test(raw) ? 'some of its answer could not be read' : null
}
export function progressOf(rows: SourceRunRow[], jobStatus: string): SourceProgress[] {
  const running = jobStatus === 'running' || jobStatus === 'pending'
  return rows.map(r => {
    const candidates = num(r.candidate_count), accepted = num(r.verified_count), review = num(r.review_count)
    const rejected = candidates !== null && accepted !== null && review !== null ? Math.max(0, candidates - accepted - review) : null
    const raw = String(r.status ?? ''), status = sourceStatusOf(raw, running)
    return { source: String(r.collector ?? ''), state: stateOf(raw, status), status, note: partialNote(raw) ?? (status === 'no_candidates' ? `${num(r.evidence_count) ?? 'some'} items read, none extracted as candidates` : null), candidates, accepted, review, rejected }
  }).filter(p => p.source)
}

// Inputs for scanOutcome() from the run report and the source rows: which sources failed, the per-reason counts of everything rejected, and how many search results came back.
export interface SourceFindings { evidence_sources: { source: string; evidence: number }[]; unknown_sources: string[] }
// Per recorded source (a null evidence or candidate count is UNKNOWN, even on status ok; a queued source is unknown), beyond the search: returned evidence but extracted no candidates (NOT a zero result), or gave nothing usable / was not run (unknown). A source that genuinely
// returned nothing is in neither list. Only search:tinyfish recorded 'unavailable' reads as "no results", and only when the run report shows ITS attempts all succeeded with 0 hits; the news fallback is judged by its own row ('empty' = zero hits, 'unavailable' = no queries or hits without usable page evidence = unknown).
export function sourceFindings(rows: SourceRunRow[], jobStatus: string, searchEmptyOk: boolean): SourceFindings {
  const evidence_sources: SourceFindings['evidence_sources'] = [], unknown_sources: string[] = []
  const rawOf = new Map(rows.map(r => [String(r.collector ?? ''), String(r.status ?? '')]))
  for (const p of progressOf(rows, jobStatus)) {
    const ev = num(rows.find(r => String(r.collector) === p.source)?.evidence_count)
    if (p.status === 'failed' || p.status === 'running') continue
    if (p.status === 'skipped') continue   // deliberately not asked (e.g. no hiring signal in the request): neither evidence nor a zero
    if (p.state === 'queued') { unknown_sources.push(p.source); continue }   // not started: unknown, whatever its counts say
    if (p.status === 'unavailable' && !(searchEmptyOk && p.source === 'search:tinyfish')) { unknown_sources.push(p.source); continue }
    if (p.status === 'unavailable') continue   // TinyFish's own row, cleared by ITS report (a clean 0)
    const cand = p.candidates
    if (cand !== null && cand > 0) continue    // produced candidates: not an empty source
    if (/^partial/i.test(rawOf.get(p.source) ?? '')) { unknown_sources.push(p.source); continue }   // answered, but some of it could not be read (malformed / oversize payload): unknown, never a zero
    if (ev !== null && ev > 0) { evidence_sources.push({ source: p.source, evidence: ev }); continue }   // evidence, no candidates: said by name, never a zero
    // A genuine nothing is stated, not assumed: 'empty', or an explicit 0 evidence AND 0 candidates. A null count (even on status ok) is unknown, never a zero.
    if (p.status === 'empty' || (ev === 0 && cand === 0)) continue
    unknown_sources.push(p.source)
  }
  return { evidence_sources, unknown_sources }
}

export function outcomeInputs(report: unknown, rows: SourceRunRow[], jobStatus: string): { failed_sources: string[]; reject_reasons: Record<string, number> | null; search_hits: number | null; partial_sources: string[] } & SourceFindings {
  const rep = (report && typeof report === 'object' ? report : {}) as { funnel?: { review_reasons?: Record<string, number>; drop_reasons?: Record<string, number> }; search?: { hits_unique_urls?: number | null; hits_raw?: number | null; ok?: number | null; attempted?: number | null } | null }
  const partial = new Map(rows.map(r => [String(r.collector ?? ''), /^error_partial:(\d+)_of_(\d+)/.exec(String(r.status ?? ''))] as const))
  const failed = progressOf(rows, jobStatus).filter(p => p.status === 'failed').map(p => { const m = partial.get(p.source); return m ? `${p.source} (${m[1]} of ${m[2]} requests failed)` : p.source })
  const search = rep.search ?? null
  // The report's `search` block describes the TinyFish search ONLY (the news fallback has its own row), so it speaks for that source alone. ANY failed attempt (1 of 3 succeeded) is a
  // named failure of that source: the empty result is then not proof of anything.
  const attempted = typeof search?.attempted === 'number' ? search.attempted : 0, ok = typeof search?.ok === 'number' ? search.ok : null
  if (attempted > 0 && ok !== null && ok < attempted && !failed.some(f => f.startsWith('search:tinyfish'))) failed.push(ok === 0 ? 'search:tinyfish' : `search:tinyfish (${attempted - ok} of ${attempted} search attempts failed)`)
  const reasons: Record<string, number> = {}
  for (const [k, v] of Object.entries(rep.funnel?.review_reasons ?? {})) if (typeof v === 'number' && v > 0) reasons[`review:${k}`] = v
  for (const [k, v] of Object.entries(rep.funnel?.drop_reasons ?? {})) if (typeof v === 'number' && v > 0) reasons[`dropped:${k}`] = v
  const hits = typeof search?.hits_unique_urls === 'number' ? search.hits_unique_urls : typeof search?.hits_raw === 'number' ? search.hits_raw : null
  const searchEmptyOk = attempted > 0 && ok === attempted && hits === 0   // a clean zero from TinyFish: clears TinyFish's own 'unavailable' row, no other source's
  const partial_sources = progressOf(rows, jobStatus).filter(p => p.status === 'partial').map(p => `${p.source} (${p.note})`)
  return { failed_sources: failed, partial_sources, reject_reasons: Object.keys(reasons).length ? reasons : null, search_hits: hits, ...sourceFindings(rows, jobStatus, searchEmptyOk) }
}
