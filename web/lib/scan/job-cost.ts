// #1517: the one recorded cost of a scan job, read the same way by its page (status cost line and outcome), the Leads history
// list and the campaign record.
//
// A job row carries two spend columns, and both are views of THE SAME paid calls:
//   - spend_cap_reserved_usd: the per-scan cap ledger (spend-cap.ts). Every paid provider call of the scan reserves its worst
//     case here before it is sent and settles to the vendor-reported cost after (a call with no reported cost keeps its worst
//     case). It is the running total of the per-call ledger, scan_spend_calls.
//   - spend_reserved_usd: the run-budget guard (runner.ts jobGuard, only when the run has a max_usd or is a capped lane). It
//     reserves and settles the same model calls (spend-guard.ts settleAll).
// Adding them counts every guarded call twice (prod run 679a7354: $0.68 in each column, record $1.36). The cap ledger covers
// every paid call, so it is never below the run guard; a job from before the cap ledger existed has only the run guard's
// amount. The larger of the two is therefore the job's cost on every row.
const amount = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?(e-?\d+)?\s*$/i.test(v) ? Number(v) : null
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null
}

// Values as stored (Postgres returns numeric columns as strings). An empty column is 0; a value that is not an amount is
// ignored; null only when neither column holds a readable amount.
export function recordedJobCostUsd(runReservedUsd: unknown, capReservedUsd: unknown): number | null {
  const run = runReservedUsd == null ? 0 : amount(runReservedUsd)
  const cap = capReservedUsd == null ? 0 : amount(capReservedUsd)
  if (run === null && cap === null) return null
  return Math.max(run ?? 0, cap ?? 0)
}
