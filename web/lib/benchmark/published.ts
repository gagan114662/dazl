// The published scorecard (#398): what Gagan reads at /app/scorecard. Pure: it turns a published batch report (runner.ts, #397) and an
// optional repeated-run analysis (superiority.ts) into display rows, and nothing else. It computes no score and calls nothing.
//
// Rules this view enforces, so the page can never say more than the evidence does:
//  - A SYNTHETIC batch is only ever shown as an example, under its own label. It is never the headline and never ranked.
//  - A system that did not run is "not run", with the reason. It has no numbers and no rank: it is never a loser.
//  - Unknown stays unknown: a missing percentage or cost reads "n/a" or "unknown", never 0.
//  - "Winner" appears only for overall decision `win` on a live or recorded batch. A failed critical floor reads "no winner".
//  - Evaluator-validated performance is kept apart from customer outcomes, which this page does not measure.
import type { BatchResult, SystemReport } from './runner.ts'
import type { Superiority } from './superiority.ts'

export type PublishedBatch = Pick<BatchResult, 'report' | 'spent_usd'> & {
  manifest: Pick<BatchResult['manifest'], 'batch_id' | 'task_set_version' | 'as_of' | 'origin' | 'label' | 'budget'> & { systems: { system: string; origin: string; available: { ok: boolean; reason?: string } }[] }
  evaluator: { name: string; version: string; independent: boolean }
}
export interface Published { format: 'dazl-published-scorecard'; version: 1; generated_at: string | null; batch: PublishedBatch | null; superiority: Superiority | null }

export interface SystemRow { system: string; ran: boolean; line: string; facts: { label: string; value: string }[] }
export interface MetricRow { metric: string; decision: string; detail: string }
export interface SuperiorityView { overall: string; why: string; plan: string; metrics: MetricRow[]; floors: { id: string; state: string; detail: string }[]; targets: string[] }
export interface BatchView { label: string; origin: string; meta: string; evaluator: string; systems: SystemRow[]; note: string }
export interface ScorecardView {
  state: 'published' | 'none'
  headline: string
  live: BatchView | null
  superiority: SuperiorityView | null
  superiorityNote: string
  example: BatchView
  limits: string[]
}

const pct = (v: number | null) => v === null ? 'n/a' : `${Math.round(v * 100)}%`
const usd = (v: number | null) => v === null ? 'unknown' : `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`
const secs = (v: number | null) => v === null ? 'n/a' : `${Math.round(v)} s`

export function systemRow(r: SystemReport): SystemRow {
  if (r.status !== 'ran') return { system: r.system, ran: false, line: `Not run: ${r.reason ?? 'no authorized adapter'}. Not ranked, and not counted as a loss.`, facts: [] }
  return {
    system: r.system, ran: true, line: `Completed ${r.complete} of ${r.tasks} tasks${r.coverage === null ? '' : ` (${pct(r.coverage)} coverage)`}.`,
    facts: [
      { label: 'Precision, top 5', value: pct(r.precision_at_5) }, { label: 'Precision, top 10', value: pct(r.precision_at_10) },
      { label: 'Validated leads', value: String(r.validated) }, { label: 'Found by no other system', value: String(r.unique_actionable_yield) },
      { label: 'Time', value: secs(r.seconds) }, { label: 'Spend', value: usd(r.spend_usd) }, { label: 'Human interventions', value: String(r.interventions) },
    ],
  }
}

export function batchView(b: PublishedBatch): BatchView {
  const m = b.manifest
  return {
    label: m.label, origin: m.origin,
    meta: `Task set ${m.task_set_version}, as of ${m.as_of}. Same budget for every system: ${usd(m.budget.usd_per_task)} and ${m.budget.seconds_per_task} s per task, ${usd(m.budget.batch_usd)} for the batch (spent ${usd(b.spent_usd)}).`,
    evaluator: `Judged by ${b.evaluator.name} ${b.evaluator.version}, blind to which system produced each result${b.evaluator.independent ? '' : ' (NOT independent of the system under test, so no threshold can be met)'}.`,
    systems: [...b.report].sort((a, c) => Number(c.status === 'ran') - Number(a.status === 'ran') || a.system.localeCompare(c.system)).map(systemRow),
    note: 'A result counts as validated only when identity, constraints, event date and contact all pass. Unknown never counts as a pass.',
  }
}

const DECISION_WORD: Record<string, string> = { win: 'Win', loss: 'Loss', inconclusive: 'Inconclusive' }
export function superiorityView(s: Superiority): SuperiorityView {
  const enough = new Set(s.batches).size >= 2   // one batch can never show a win
  // One batch can show neither a win nor a loss: the headline, every metric row and every target say so together, with no interval and no "met".
  const decided = s.overall.decision === 'win' || s.overall.decision === 'loss'
  const overall = decided && !enough ? 'Inconclusive: a win or a loss needs at least 2 distinct batches' : s.overall.decision === 'win' ? `${s.systems.candidate} wins` : s.overall.decision === 'loss' ? `${s.systems.candidate} loses` : s.overall.decision === 'no_winner_floor_failed' ? 'No winner: a critical accuracy floor failed' : 'Inconclusive'
  const range = (i: [number, number] | null) => i ? `${i[0].toFixed(3)} to ${i[1].toFixed(3)}` : 'no interval'
  return {
    overall: s.origin === 'synthetic' ? `Example only: ${overall}` : overall, why: s.overall.why,
    plan: `Plan ${s.plan.id} (hash ${s.plan.hash.slice(0, 12)}), registered ${s.plan.registered_at} before any result was viewed. Look ${s.look}.`,
    metrics: s.metrics.map(m => ({ metric: m.metric.replace(/_/g, ' '), decision: enough ? DECISION_WORD[m.decision] ?? m.decision : 'Inconclusive', detail: !enough ? `Not shown: one batch cannot show a difference or an interval (${m.pairs} pairs in ${m.clusters} clusters).` : `Difference ${m.difference === null ? 'n/a' : m.difference.toFixed(3)}, interval ${range(m.interval)}, ${m.pairs} pairs in ${m.clusters} clusters. ${m.why}` })),
    floors: s.floors.map(f => ({ id: f.id.replace(/_/g, ' '), state: f.ok === null ? 'not evaluable' : f.ok ? 'holds' : 'FAILED', detail: f.detail })),
    targets: [
      `Precision floor ${pct(s.targets.precision_floor.target)}: ${!enough || s.targets.precision_floor.met === null ? 'not shown (one batch)' : s.targets.precision_floor.met ? 'met' : 'not met'}.`,
      `Yield advantage x${s.targets.yield_advantage.target}: ${!enough || s.targets.yield_advantage.met === null ? 'not shown (one batch)' : s.targets.yield_advantage.met ? 'met' : 'not met'}.`,
    ],
  }
}

export const LIMITS = [
  'This is evaluator-validated performance. It is not a measure of customer outcomes (replies, meetings), which need an opted-in pilot.',
  'A competitor with no authorized account or adapter is shown as not run. It is never ranked, and never counted as a loss.',
  'Numbers come from the preregistered task set and plan. A plan changed after results were seen would be a different plan with a different hash.',
]

export function scorecardView(p: Published | null, example: Published): ScorecardView {
  const exampleView = batchView(example.batch as PublishedBatch)
  const live = p?.batch && (p.batch.manifest.origin === 'live' || p.batch.manifest.origin === 'recorded') ? p.batch : null
  const sup = live && p?.superiority && p.superiority.origin !== 'synthetic' ? p.superiority : null
  return {
    state: live ? 'published' : 'none',
    headline: live ? `Latest comparison: ${live.manifest.origin} results, ${live.manifest.as_of}` : 'No live or recorded comparison has been run yet.',
    live: live ? batchView(live) : null,
    superiority: sup ? superiorityView(sup) : null,
    superiorityNote: sup ? '' : live ? 'Repeated-run comparison not published yet: one batch cannot show a win, a loss or an interval.' : 'No win or loss can be stated until repeated live runs of the same task set exist.',
    example: exampleView, limits: LIMITS,
  }
}
