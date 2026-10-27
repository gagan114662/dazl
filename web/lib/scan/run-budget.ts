// Per-run cost controls for the ordinary scan route (POST /api/scan). Instinct #204 (cost-control gap): the CSV route took
// narrowing controls but the customer route did not, and exposing a max_usd must not be sold as a vendor-guaranteed ceiling.
//
// What a budget IS here, stated once and returned to the caller with every accepted request (describeRunBudget):
//  - narrowing flags (paid_fallback / credit_enrichment / judge = false) switch a paid surface OFF;
//  - THIS IS A PARTIAL, API-ONLY BUDGET, not a whole-scan dollar ceiling (see BUDGET_EXCLUDED_PATHS).
//  - max_usd is a reservation limit computed from what dazl sends (prompt bytes, or count_tokens x 1.2, plus max_tokens at the
//    model's listed price), NOT a bill and not a vendor-enforced ceiling. Web-search research cannot be bounded, so a run with
//    max_usd REFUSES it. A refused call ends the run as `budget_stopped`, which is not the same as "nothing found".
//  - the job's own reservation is saved after every reserved call, so a retry or a restart of THAT job continues from what it
//    already reserved; the per-owner pool (DAZL_RUN_MAX_USD_USERS) lives in process memory and resets on a restart.
// Absent budget = today's behaviour, unbounded. A supplied budget is validated strictly: a caller expecting a restricted
// run is never silently widened into a full one.
import type { RunBudget } from './runner.ts'

export const MAX_BUDGET_USD = 1000 // sanity bound on the number, not a claim about any invoice
const NARROWING = ['paid_fallback', 'credit_enrichment', 'judge'] as const

export type BudgetCheck = { ok: true; value: string | null; budget: RunBudget | null } | { ok: false; error: string }
export function normalizeScanBudget(raw: unknown, supplied: boolean): BudgetCheck {
  if (!supplied) return { ok: true, value: null, budget: null }
  if (raw === undefined || raw === null) return { ok: false, error: 'budget was supplied but empty - name a control (paid_fallback, credit_enrichment, judge = false, or max_usd) or omit the field' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'budget must be an object' }
  const o = raw as Record<string, unknown>; const keys = Object.keys(o)
  if (keys.length === 0) return { ok: false, error: 'budget names no controls' }
  const out: RunBudget = {}
  for (const k of keys) {
    if (k === 'max_usd') {
      const v = o[k]
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_BUDGET_USD) return { ok: false, error: `budget.max_usd must be a number above 0 and at most ${MAX_BUDGET_USD}` }
      out.max_usd = v
    } else if ((NARROWING as readonly string[]).includes(k)) {
      if (o[k] !== false) return { ok: false, error: `budget.${k} accepts only false - the control can only narrow a run` }
      ;(out as Record<string, boolean>)[k] = false
    } else return { ok: false, error: `unknown budget control: ${k}` }
  }
  return { ok: true, value: JSON.stringify(out), budget: out }
}

export type SurfaceStatus = 'allowed' | 'refused' | 'off' | 'not_covered'
// This budget is PARTIAL by construction. It bounds only the model requests that go through the job's guarded provider.
// These paths are outside it, said in every accepted response, in the PR and in docs/STATUS.md.
export const BUDGET_EXCLUDED_PATHS = [
  'Profile generation (/api/scan/icp) - a separate request before the run',
  'TinyFish search and fetch (their own per-scan, per-tenant and global caps apply instead)',
  'Free sources: GDELT news search, public job boards, SEC Form D, the company-site crawl',
  'People search after the scan (TinyFish searches under their own caps)',
  'Autopilot and every outreach action (drafting, AI rewrite, follow-ups, replies) - separate features on their own keys and switches',
  'Monitors / weekly watches and CSV imports - they create jobs of their own (CSV takes the narrowing flags only, no max_usd)',
  'Bring-your-own-key Apollo / People Data Labs enrichment is switched OFF under max_usd, not bounded',
  'Retries below dazl (provider or platform) and the provider\'s real billing - requests are counted where dazl sends them',
  'The per-owner pool (DAZL_RUN_MAX_USD_USERS) - in memory, resets on a restart',
]
export interface BudgetDisclosure {
  scope: 'partial'
  excluded_paths: string[]
  bounded: boolean
  max_usd: number | null
  ceiling: string
  surfaces: { surface: string; status: SurfaceStatus; note: string }[]
  limits: string[]
}
// Exactly which paid surfaces this budget allows or refuses. Derived from the budget alone, so the response cannot say more
// or less than the runner enforces. (The test pins each row to the runner's behaviour.)
export function describeRunBudget(b: RunBudget | null): BudgetDisclosure {
  const capped = typeof b?.max_usd === 'number'
  const llm = (note: string): { status: SurfaceStatus; note: string } => capped ? { status: 'allowed', note: `${note}; each call is reserved against max_usd and refused when it would pass it` } : { status: 'allowed', note: `${note}; no dollar limit` }
  const row = (surface: string, r: { status: SurfaceStatus; note: string }) => ({ surface, ...r })
  const fallbackOff = b?.paid_fallback === false
  return {
    scope: 'partial',
    excluded_paths: BUDGET_EXCLUDED_PATHS,
    bounded: capped,
    max_usd: capped ? b!.max_usd! : null,
    ceiling: capped ? 'PARTIAL budget, not a whole-scan dollar ceiling: a reservation limit on the guarded model requests only (listed price x prompt size + max output). Not a bill and not a vendor-enforced ceiling. See excluded_paths.' : 'None. Without max_usd the run is not dollar-bounded. Narrowing flags switch single surfaces off; they are not a dollar limit either.',
    surfaces: [
      row('profile_generation', { status: 'not_covered', note: 'Happens before the run, in its own request (/api/scan/icp); this budget does not apply to it' }),
      row('search_query_writing', llm('One model call')),
      row('extraction', llm('One model call per attempt')),
      row('scoring', llm('Grades the verified leads')),
      row('grounding', fallbackOff ? { status: 'refused', note: 'Only runs after fallback research, which paid_fallback=false refuses' } : capped ? { status: 'refused', note: 'Only runs after fallback research, which max_usd refuses' } : llm('Runs only after fallback research')),
      row('buyer_fit', llm('Checks hiring leads against the company home page')),
      row('judge', b?.judge === false ? { status: 'off', note: 'judge=false' } : llm('Verification judge')),
      row('fallback_research', fallbackOff ? { status: 'refused', note: 'paid_fallback=false: the run stops as budget_stopped instead of using web-search research' } : capped ? { status: 'refused', note: 'Web-search research cannot be bounded, so a run with max_usd refuses it. This is NOT the same search behaviour as an ordinary scan: when search finds nothing the run ends as budget_stopped' } : { status: 'allowed', note: 'Web-search research when search finds nothing; cost is not bounded by anything dazl sends' }),
      row('credit_enrichment', b?.credit_enrichment === false || capped ? { status: 'off', note: capped ? 'Off for any run with max_usd' : 'credit_enrichment=false' } : { status: 'allowed', note: 'Bring-your-own-key Apollo/People Data Labs, on your own credits' }),
      row('search_and_fetch', { status: 'not_covered', note: 'TinyFish search and fetch are counted against their own per-scan, per-tenant and global caps, not against max_usd' }),
    ],
    limits: [
      'A refused call ends the run as budget_stopped. That is a budget stop, not zero results.',
      'The job reservation is saved after every reserved call and survives a retry or restart of that job; the per-owner pool (DAZL_RUN_MAX_USD_USERS) is in memory and resets when the process restarts.',
      'Token counts come from the provider count endpoint x 1.2 (a chosen margin, not a documented maximum), or prompt bytes when no counter is available.',
      'Only models with a listed price are allowed under max_usd; an unpriced model refuses every call.',
    ],
  }
}
