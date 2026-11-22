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
// #1168: model calls of this scan that a spending LIMIT refused before they were sent (null: the ledger could not be read). Only the
// numeric-limit reasons: a config or accounting refusal is not a spending limit, and the cost line must not call it one.
export async function readRefusedModelCalls(db: Db, tenantId: string, jobId: string): Promise<number | null> {
  try {
    // The ledger, not scan_model_calls, says whether a model call was SENT: a reserved / settled / kept llm row is a call that left
    // (scan_model_calls is empty when DAZL_MODEL_USAGE=0 or a record write failed). Any such row: null, so the cost line keeps its
    // unknown-cost wording and never claims "no model call was made" (review at b8eef37e).
    const r = await db.get<{ n: number | string; sent: number | string | null }>("SELECT SUM(CASE WHEN status = 'refused' AND reason IN ('over_limit', 'over_cap', 'owner_pool_limit') THEN 1 ELSE 0 END) AS n, SUM(CASE WHEN status <> 'refused' THEN 1 ELSE 0 END) AS sent FROM scan_spend_calls WHERE user_id = ? AND scan_job_id = ? AND kind LIKE 'llm.%'", [tenantId, jobId])
    if (!r) return null
    return Number(r.sent ?? 0) > 0 ? null : Number(r.n ?? 0)
  } catch { return null }
}
// #1517: how many of this job's paid calls never reported a cost (still 'reserved', or 'kept' at their reservation after a
// failed or unreadable answer), owner-scoped. They are in the job's recorded cost at the amount reserved for them, and the
// final-cost line says so. null when unreadable.
export async function readHeldPaidSteps(db: Db, tenantId: string, jobId: string): Promise<number | null> {
  try {
    const row = await db.get<{ n: number | string | null }>("SELECT COUNT(*) AS n FROM scan_spend_calls c JOIN scan_jobs j ON j.id = c.scan_job_id AND j.user_id = c.user_id WHERE j.user_id = ? AND j.id = ? AND c.status IN ('reserved', 'kept') AND c.reserve_usd > 0", [tenantId, jobId])
    const n = Number(row?.n)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  } catch { return null }
}
export async function readJobCost(db: Db, tenantId: string, jobId: string): Promise<{ estimate: string | null; reserved_usd: number | null; cap_reserved_usd: number | null; /** the row was read: reserved_usd null then means the column is empty, not that the read failed */ read: boolean }> {
  try {
    // Both reservation columns: spend_reserved_usd (a max_usd run's reservation) AND spend_cap_reserved_usd (the per-job
    // spend-cap ledger, spend-cap.ts). Reading only the first hid real reserved spend on cap-only runs. NULL stays null.
    const row = await db.get<{ estimate: string | null; spend_reserved_usd: number | string | null; spend_cap_reserved_usd: number | string | null }>('SELECT estimate, spend_reserved_usd, spend_cap_reserved_usd FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId])
    return { estimate: row?.estimate ?? null, reserved_usd: row?.spend_reserved_usd == null ? null : Number(row.spend_reserved_usd), cap_reserved_usd: row?.spend_cap_reserved_usd == null ? null : Number(row.spend_cap_reserved_usd), read: !!row }
  } catch { return { estimate: null, reserved_usd: null, cap_reserved_usd: null, read: false } }
}

// #1319: the per-scan cap a free-trial job ran under: what its trial reservation held (the job guard's limit, runner.ts).
// Jobs started before the estimate kept the cap read it from here. Owner-scoped, read only; null when none is recorded.
// It is the reservation amount (trialCaps().reserveUsd when the job started), the same value the estimate keeps.
// 'unreadable' when the read fails: the caller never treats "could not read" as "no cap".
export async function readTrialScanCap(db: Db, tenantId: string, jobId: string): Promise<number | null | 'unreadable'> {
  try {
    const row = await db.get<{ r: number | string | null }>("SELECT MAX(reserve_usd) AS r FROM trial_reservations WHERE tenant_id = ? AND job_id = ? AND kind = 'scan'", [tenantId, jobId])
    const v = row?.r == null ? null : Number(row.r)
    return v !== null && Number.isFinite(v) && v > 0 ? v : null
  } catch { return 'unreadable' }
}

// #1157 line 2: when this scan last did something the server recorded (a paid/free provider call sent or settled), so a
// running page can say "last activity N s ago" instead of a silent "Still running". Owner-scoped, read only. null = no
// call recorded yet (or the table does not exist): the page then falls back to the claim time, never an invented time.
export async function readLastActivity(db: Db, tenantId: string, jobId: string): Promise<number | null> {
  try {
    const row = await db.get<{ c: number | string | null; s: number | string | null }>('SELECT MAX(c.created_at) AS c, MAX(c.settled_at) AS s FROM scan_spend_calls c JOIN scan_jobs j ON j.id = c.scan_job_id AND j.user_id = c.user_id WHERE j.user_id = ? AND j.id = ?', [tenantId, jobId])
    const vals = [row?.c, row?.s].map(v => (v == null ? null : Number(v))).filter((v): v is number => v !== null && Number.isFinite(v))
    return vals.length ? Math.max(...vals) : null
  } catch { return null }
}
