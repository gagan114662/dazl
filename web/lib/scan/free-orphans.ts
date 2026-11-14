// #1157: a paid-call row left 'reserved' by a scan attempt that is gone (a restart, a crash, a lease that ran out) means "may have been
// billed", and every reaper and hand-back ends such a scan accounting_uncertain and never runs it again. That is right for a call
// with a price. It is wrong for a call that was priced at US$0 when it was reserved: TinyFish search and fetch inside its free
// allowance (lib/scan/spend-cap.ts unitCostUsd). Nothing could have been billed for it, so the row is settled at $0 and the scan is
// treated as any other interrupted one (given back to pending, or ended 'timeout' on its last attempt) instead of failing with
// "a paid step may already have been billed" and discarding everything it found. This mirrors freeFailure in lib/search/tinyfish.ts
// (the same rule for a call that fails inside a live process). A priced row, any other kind of call, and every spend cap are
// untouched. Portable SQL (SQLite and Postgres); '?' placeholders, numbered for Postgres by numbered().
const FREE_ORPHAN = "UPDATE scan_spend_calls SET status = 'settled', actual_usd = 0, reason = 'interrupted_free', settled_at = ? WHERE status = 'reserved' AND reserve_usd = 0 AND kind IN ('tinyfish.search', 'tinyfish.fetch')"

// params: now, cutoff. The scans a reaper is about to end: running, claim older than the cutoff.
export const SETTLE_FREE_ORPHANS_STALE_SQL = `${FREE_ORPHAN} AND scan_job_id IN (SELECT id FROM scan_jobs WHERE status = 'running' AND claimed_at < ?)`
// params: now, jobId. One scan whose attempt this process owns and is handing back.
export const SETTLE_FREE_ORPHANS_JOB_SQL = `${FREE_ORPHAN} AND scan_job_id = ?`
// params: now, jobId, tenantId, cutoff. One queued scan about to be bound: pending, or running with a claim older than the cutoff.
export const SETTLE_FREE_ORPHANS_BIND_SQL = `${FREE_ORPHAN} AND scan_job_id IN (SELECT id FROM scan_jobs WHERE id = ? AND user_id = ? AND (status = 'pending' OR (status = 'running' AND claimed_at <= ?)))`

export const numbered = (sql: string): string => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`) }
