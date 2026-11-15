// #1157: what happens to the paid-call rows an interrupted scan attempt left 'reserved'.
//
// A row left 'reserved' by an attempt that is gone means "may have been billed", and every reaper, bind and hand-back ends such a scan
// accounting_uncertain and never runs it again (#363 / #594: re-running could bill the same call twice). Two cases are not that:
//
// 1. A FREE call: TinyFish search and fetch priced at US$0 inside its free allowance (lib/scan/spend-cap.ts unitCostUsd). Nothing could
//    have been billed, so the row is settled at $0 (reason 'interrupted_free') and the scan is treated as any interrupted one (back to
//    pending, or 'timeout' on its last attempt). Every reaper, the queue bind and the shutdown hand-back do this. It mirrors freeFailure in
//    lib/search/tinyfish.ts (the same rule inside a live process). A free call a live attempt flagged maybe billed (a 402) carries
//    reason 'maybe_billed' (spend-cap.ts uncertainDurable()) and is NOT settled here.
//
// 2. A MODEL call this process itself abandons at a graceful shutdown (a deploy's SIGTERM): the staging scan #1157 was filed for died
//    3 seconds into a model call when a deploy stopped the process. The hand-back knows exactly which call it is abandoning (this
//    attempt's own), so the call is recorded 'kept': charged at its reserved worst case, as an in-process settle with an unknown cost
//    is (reason 'interrupted_kept'). The accounting is then certain, and the scan goes back to pending and runs again on the next
//    process. ONLY the hand-back does this. A scan whose process died without one (a crash, SIGKILL, out of memory) is found by a
//    reaper, which cannot tell an abandoned call from one still in flight on another host: it keeps the fail-closed rule.
//
// A priced non-model call (a priced TinyFish call, Apollo, PDL, render) is untouched everywhere, and so is every spend cap: a kept
// call stays counted at its worst case against the scan's own cap, so a re-run cannot spend past it.
//
// Every statement is driven by (user_id, scan_job_id), the scan_spend_calls_job index: none scans the table. The reapers first read
// the stale scans through scan_jobs' status index (STALE_SCANS_SQL), then update each scan's rows. Portable SQL (SQLite, Postgres,
// pg-mem); '?' placeholders, numbered for Postgres by numbered().
const FREE = "UPDATE scan_spend_calls SET status = 'settled', actual_usd = 0, reason = 'interrupted_free', settled_at = ? WHERE status = 'reserved' AND reserve_usd = 0 AND kind IN ('tinyfish.search', 'tinyfish.fetch') AND reason IS NULL"

// params: cutoff. The scans a reaper is about to end: running, claim older than the cutoff.
export const STALE_SCANS_SQL = "SELECT id, user_id FROM scan_jobs WHERE status = 'running' AND claimed_at < ?"
// params: now, userId, jobId, jobId, userId, cutoff. One stale scan's free rows; the EXISTS re-checks it is still stale at write time.
export const SETTLE_FREE_ORPHANS_STALE_SQL = `${FREE} AND user_id = ? AND scan_job_id = ? AND EXISTS (SELECT 1 FROM scan_jobs WHERE id = ? AND user_id = ? AND status = 'running' AND claimed_at < ?)`
// params: now, userId, jobId, jobId, userId, cutoff. One queued scan about to be bound: pending, or running with a claim older than the cutoff.
export const SETTLE_FREE_ORPHANS_BIND_SQL = `${FREE} AND user_id = ? AND scan_job_id = ? AND EXISTS (SELECT 1 FROM scan_jobs WHERE id = ? AND user_id = ? AND (status = 'pending' OR (status = 'running' AND claimed_at <= ?)))`
// params: now, userId, jobId, attempt. The attempt this process owns and is handing back: its own rows only.
export const SETTLE_FREE_ORPHANS_JOB_SQL = `${FREE} AND user_id = ? AND scan_job_id = ? AND attempt = ?`
// params: now, userId, jobId, attempt. Case 2 above: the hand-back only.
export const KEEP_MODEL_CALLS_JOB_SQL = "UPDATE scan_spend_calls SET status = 'kept', reason = 'interrupted_kept', settled_at = ? WHERE status = 'reserved' AND kind IN ('llm.anthropic', 'llm.openai') AND reason IS NULL AND user_id = ? AND scan_job_id = ? AND attempt = ?"

export const numbered = (sql: string): string => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`) }
