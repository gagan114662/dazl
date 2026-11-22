// #1517: the one recorded cost of a scan job, read the same way by its page (status cost line and outcome), the Leads history
// list and the campaign record.
//
// A job row carries two spend columns over the same paid calls:
//   - spend_cap_reserved_usd: the per-scan cap ledger (spend-cap.ts). Every paid provider transport (model completions,
//     TinyFish, page renders, Apollo, PDL) reserves its worst case here before the request and settles it to the
//     vendor-reported cost after; a call with no reported cost keeps its reservation ('kept'), a refused one adds nothing. It
//     is the running total of the per-call ledger, scan_spend_calls: the truth.
//   - spend_reserved_usd: the run-budget guard (runner.ts jobGuard), which wraps the model calls (and a free trial's TinyFish
//     charges at the trial's prices). It is a limit's running total, not a cost: a trial's guard never settles down from the
//     worst case, and an unknown-cost call exhausts it to the full limit.
// Adding them counted every guarded call twice (#1517: $0.68 in each column, record $1.36). So the cost is the cap ledger's
// total whenever it holds anything; only a job from before the cap ledger existed (nothing in it) falls back to the run
// guard's amount, the one record such a job has.
// One later case also lands on the run guard: a free trial whose only paid steps were TinyFish calls inside the free
// allowance (the cap ledger prices them at $0; the trial guard charges them at the trial's prices). It shows that trial charge,
// an overstatement, never "Nothing was charged" for a run that drew on its trial reserve.
const amount = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(v) ? Number(v) : NaN   // decimal forms only (never 0x..)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Values as stored (Postgres returns numeric columns as strings). An empty column is 0. A column that holds something other
// than an amount makes the cost unknown (null): it never reads as $0, so it never becomes "Nothing was charged".
export function recordedJobCostUsd(runReservedUsd: unknown, capReservedUsd: unknown): number | null {
  const run = runReservedUsd == null ? 0 : amount(runReservedUsd)
  const cap = capReservedUsd == null ? 0 : amount(capReservedUsd)
  if (run === null || cap === null) return null
  return cap > 0 ? cap : run
}
