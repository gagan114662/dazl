// One bounded adaptive discovery round (#381), run after the first batch is verified and before anything is graded: when the batch left fewer actionable leads than the target, the
// planner (discovery-rounds.ts) diagnoses where candidates were lost and picks genuinely new queries within hard limits; the caller's `search` finds candidates for them, `verify` puts
// them through the SAME verifier and gates, and every query is recorded so one that failed or came back empty is never paid for twice. The constraints (request, profile, geography,
// windows) are never widened here - widening is the user's choice - and a limit is reported as a limit ("stopped at the budget"), never as an empty market.
import type { Db } from '../db/client.ts'
import { DEFAULT_BUDGET, diagnose, failedQueryKeys, loadRounds, nextRound, recordRound, type Budget, type Decision, type Funnel, type RoundRecord } from './discovery-rounds.ts'

export interface AdaptiveInput {
  db: Db; tenantId: string; jobId: string; query: string
  icp: { signals: string[]; where: string[] }
  funnel: Funnel
  source: string                                         // the one source this caller can run (e.g. 'search:news'); the planner is limited to it
  spent: { searches: number; pages: number; ms: number }
  now: Date
  search: (queries: string[]) => Promise<{ found: number } | null>   // runs the queries, returns how many NEW candidates were added (null = the source could not answer)
  verify: () => Promise<number>                         // verifies what was added through the normal gates; returns the actionable count afterwards
  budget?: Partial<Budget>
}
export interface AdaptiveReport { ran: boolean; decision: Decision; diagnosis: string; queries: string[]; found: number; actionable_before: number; actionable_after: number }

export async function runAdaptiveRound(a: AdaptiveInput): Promise<AdaptiveReport> {
  const history = await loadRounds(a.db, a.tenantId, a.jobId)
  const failedKeys = await failedQueryKeys(a.db, a.tenantId, Math.floor(a.now.getTime() / 1000) - 14 * 86400)
  const decision = nextRound({ query: a.query, icp: a.icp, funnel: a.funnel, history, spent: a.spent, budget: a.budget, failedKeys, sources: [a.source], now: a.now })
  const base = { decision, diagnosis: diagnose(a.funnel), queries: [] as string[], found: 0, actionable_before: a.funnel.actionable, actionable_after: a.funnel.actionable }
  if (decision.action !== 'search') return { ran: false, ...base }
  const round = new Set(history.map(h => h.round)).size + 1
  let res: { found: number } | null = null, threw = false
  try { res = await a.search(decision.queries) } catch (e) { threw = true; if ((e as { name?: string })?.name === 'ScanStopped' || /scan_stopped|scan_timeout|SpendRefused/.test(String((e as Error)?.message ?? e))) throw e }
  const after = res && res.found > 0 ? await a.verify() : a.funnel.actionable
  const outcome: RoundRecord['outcome'] = threw || res === null ? 'failed' : res.found === 0 ? 'empty' : 'ok'
  for (const q of decision.queries) await recordRound(a.db, a.jobId, { round, source: decision.source, query: q, outcome, new_pages: res?.found ?? 0, actionable_after: after, why: decision.why })
  return { ran: true, ...base, queries: decision.queries, found: res?.found ?? 0, actionable_after: after }
}
