// Lead-quality benchmark CLI (issue #372; docs/BENCHMARK.md). No network and no model calls: it scores runs that
// already exist. The task set and thresholds live in ../scoreboard/benchmark/.
//   node --experimental-strip-types scripts/benchmark.mts scorecard --run RUN.json [--thresholds] [--out DIR]
//     a benchmark run (any system) -> scorecard .json and .md; --thresholds adds the PROPOSED thresholds' results
//   node --experimental-strip-types scripts/benchmark.mts from-scoreboard --result ../scoreboard/results/<file>.json --out RUN.json
//     a recorded scripts/scoreboard.mts result -> a benchmark run (verdicts are the pipeline's self-report)
//   node --experimental-strip-types scripts/benchmark.mts compare --before A.json --after B.json [--tolerance 0]
//     two scorecards of the same task set: exit 1 when a metric got worse (the release regression gate)
//   node --experimental-strip-types scripts/benchmark.mts history
//     the recorded evidence so far, with its denominators
//   node --experimental-strip-types scripts/benchmark.mts label-sheet --run RUN.json --out SHEET.csv [--seed 1]
//     a BLIND sheet of every returned result for an independent labeller (no system name, rank or own verdicts)
//   node --experimental-strip-types scripts/benchmark.mts apply-labels --run RUN.json --labels LABELS.json --out RUN2.json
//     the run with the labeller's verdicts (unlabelled = unknown); prints coverage
//   node --experimental-strip-types scripts/benchmark.mts agreement --a LABELS1.json --b LABELS2.json
//     two labellers on the same rows: observed agreement and Cohen's kappa per field
//   node --experimental-strip-types scripts/benchmark.mts paired --a A1.json,A2.json --b B1.json,B2.json [--metric validated_at_10] [--seed 1]
//     scorecards of two systems (repeated runs) on one task set: per-task paired difference with a bootstrap 95% interval
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { agreement, applyLabels, labelSheet, sheetCsv, type LabelSet } from '../lib/benchmark/labels.ts'
import { pairedComparison, type PairedMetric } from '../lib/benchmark/paired.ts'
import { evaluateThresholds, fromScoreboardResult, regressions, scorecard, scorecardMarkdown, type BenchmarkRun, type Scorecard, type TaskSet, type ThresholdSet } from '../lib/benchmark/scorecard.ts'

const dir = path.resolve(import.meta.dirname, '..', '..', 'scoreboard', 'benchmark')
const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const json = <T,>(f: string) => JSON.parse(readFileSync(f, 'utf8')) as T
const taskSet = (v: string) => json<TaskSet>(path.join(dir, `v${v}`, 'tasks.json'))
const die = (m: string, code = 2): never => { console.error(`benchmark: ${m}`); process.exit(code) }
const cmd = process.argv[2]

if (cmd === 'scorecard') {
  const run = json<BenchmarkRun>(arg('--run') ?? die('--run RUN.json is required'))
  const card = scorecard(taskSet(run.task_set_version), run)
  const th = process.argv.includes('--thresholds') ? evaluateThresholds(card, json<ThresholdSet>(path.join(dir, 'proposed-thresholds.json'))) : undefined
  const md = scorecardMarkdown(card, th)
  const out = arg('--out')
  if (out) {
    mkdirSync(out, { recursive: true })
    const base = path.join(out, `${card.system}-${card.commit ?? 'nocommit'}-v${card.task_set_version}`)
    writeFileSync(`${base}.json`, JSON.stringify({ ...card, thresholds: th ?? null }, null, 2) + '\n'); writeFileSync(`${base}.md`, md)
  }
  process.stdout.write(md)
} else if (cmd === 'from-scoreboard') {
  const file = arg('--result') ?? die('--result FILE is required'), out = arg('--out') ?? die('--out RUN.json is required')
  const run = fromScoreboardResult(json(file), taskSet('1'), path.basename(file))
  writeFileSync(out, JSON.stringify(run, null, 2) + '\n')
  console.log(`benchmark: ${run.tasks.length} task(s) from ${path.basename(file)} -> ${out} (evaluator: pipeline self-report, not independent)`)
} else if (cmd === 'compare') {
  const a = json<Scorecard>(arg('--before') ?? die('--before is required')), b = json<Scorecard>(arg('--after') ?? die('--after is required'))
  const r = regressions(a, b, Number(arg('--tolerance') ?? 0))
  if (r.length) { console.log(`benchmark: ${r.length} regression(s)\n${r.map(x => `  ${x}`).join('\n')}`); process.exit(1) }
  console.log('benchmark: no regression')
} else if (cmd === 'history') {
  const h = json<{ note: string; observations: { date: string; source: string; commit: string | null; request: string; counts: Record<string, number>; note?: string }[] }>(path.join(dir, 'history.json'))
  console.log(h.note + '\n')
  for (const o of h.observations) console.log(`${o.date}  ${o.request}  [${o.source}${o.commit ? `, ${o.commit}` : ''}]  ${Object.entries(o.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(no counts)'}${o.note ? `  - ${o.note}` : ''}`)
} else if (cmd === 'label-sheet') {
  const run = json<BenchmarkRun>(arg('--run') ?? die('--run RUN.json is required')), out = arg('--out') ?? die('--out SHEET.csv is required')
  const rows = labelSheet(run, taskSet(run.task_set_version), Number(arg('--seed') ?? 1))
  writeFileSync(out, sheetCsv(rows))
  console.log(`benchmark: ${rows.length} row(s) to label -> ${out} (blind: no system, rank or verdicts)`)
} else if (cmd === 'apply-labels') {
  const run = json<BenchmarkRun>(arg('--run') ?? die('--run is required')), out = arg('--out') ?? die('--out is required')
  const r = applyLabels(run, json<LabelSet>(arg('--labels') ?? die('--labels is required')))
  writeFileSync(out, JSON.stringify(r.run, null, 2) + '\n')
  console.log(JSON.stringify({ out, evaluator: r.run.evaluator, coverage: r.coverage }))
} else if (cmd === 'agreement') {
  const r = agreement(json<LabelSet>(arg('--a') ?? die('--a is required')), json<LabelSet>(arg('--b') ?? die('--b is required')))
  for (const f of r) console.log(`${f.field.padEnd(12)} both ${f.both_labelled}  agreed ${f.agreed}  observed ${f.observed ?? 'n/a'}  kappa ${f.kappa ?? 'n/a'}`)
} else if (cmd === 'paired') {
  const cards = (f: string) => (arg(f) ?? die(`${f} is required`)).split(',').map(x => json<Scorecard>(x.trim()))
  const r = pairedComparison(cards('--a'), cards('--b'), { metric: (arg('--metric') ?? 'validated_at_10') as PairedMetric, seed: Number(arg('--seed') ?? 1) })
  console.log(JSON.stringify(r, null, 2))
} else die('usage: benchmark.mts scorecard|from-scoreboard|compare|history|label-sheet|apply-labels|agreement|paired (see the header)')
