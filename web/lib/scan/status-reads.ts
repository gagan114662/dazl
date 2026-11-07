// Scan-status domain reads over ONE injected store. No getDb, raw handle, reaper, runner or provider calls.
import type { Db } from '../db/client.ts'
import { modelUsageOf, type ModelCall } from './model-usage.ts'

// PG returns BIGINT columns as strings; preserve NULL (unknown), and normalize only schema-known numeric columns.
export function numbers<T extends Record<string, unknown>>(row: T, keys: string[]): T {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, keys.includes(k) && v != null ? Number(v) : v])) as T
}
export async function readSourceRuns(db: Db, tenantId: string, jobId: string) {
  const rows = await db.all(`SELECT r.* FROM scan_source_runs r JOIN scan_jobs j ON j.id=r.job_id WHERE j.user_id=? AND j.id=? ORDER BY r.attempt,r.collector`, [tenantId, jobId])
  return rows.map(r => numbers(r, ['attempt', 'evidence_count', 'candidate_count', 'verified_count', 'review_count', 'inserted_count']))
}
export async function readSourceStats(db: Db, tenantId: string, jobId: string): Promise<Record<string, unknown>[] | null> {
  try {
    const rows = await db.all(`SELECT s.* FROM scan_source_stats s JOIN scan_jobs j ON j.id=s.job_id WHERE j.user_id=? AND j.id=? ORDER BY s.attempt,s.collector`, [tenantId, jobId])
    const parse = (v: unknown) => { try { return typeof v === 'string' ? JSON.parse(v) : null } catch { return null } }
    return rows.map(r => {
      const n = numbers(r, ['attempt', 'searches_attempted', 'searches_ok', 'hits_raw', 'hits_unique_urls', 'hits_complete', 'fetch_complete', 'fetch_requested', 'fetch_pages_with_text', 'distinct_hosts', 'urls_not_fetched', 'extracted_candidates', 'model_calls', 'input_tokens', 'output_tokens', 'evidence_items', 'evidence_with_page_text', 'evidence_snippet_only'])
      return { ...n, queries: parse(r.queries), per_query: parse(r.per_query), searches_failed: parse(r.searches_failed), searches_not_attempted: parse(r.searches_not_attempted) }
    })
  } catch { return null }
}
export async function readModelUsage(db: Db, tenantId: string, jobId: string) {
  try {
    const rows = await db.all<ModelCall & Record<string, unknown>>('SELECT c.* FROM scan_model_calls c JOIN scan_jobs j ON j.id=c.job_id WHERE j.user_id=? AND j.id=? ORDER BY c.attempt,c.seq', [tenantId, jobId])
    return modelUsageOf(rows.map(r => numbers(r, ['attempt', 'seq', 'input_tokens', 'output_tokens', 'max_tokens', 'prompt_chars', 'recorded_at'])))
  } catch { return modelUsageOf([]) }
}
export async function readJobCost(db: Db, tenantId: string, jobId: string): Promise<{ estimate: string | null; reserved_usd: number | null }> {
  try {
    const row = await db.get<{ estimate: string | null; spend_reserved_usd: number | string | null }>('SELECT estimate, spend_reserved_usd FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId])
    return { estimate: row?.estimate ?? null, reserved_usd: row?.spend_reserved_usd == null ? null : Number(row.spend_reserved_usd) }
  } catch { return { estimate: null, reserved_usd: null } }
}
