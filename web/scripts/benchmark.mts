// Lead-quality benchmark CLI (issue #372; docs/BENCHMARK.md). No network and no model calls: it scores runs that
// already exist. The task set and thresholds live in ../scoreboard/benchmark/.
//   node --experimental-strip-types scripts/benchmark.mts scorecard --run RUN.json [--thresholds] [--out DIR]
//     a benchmark run (any system) -> scorecard .json and .md; --thresholds adds the PROPOSED thresholds' results
//   node --experimental-strip-types scripts/benchmark.mts from-scoreboard --result ../scoreboard/results/<file>.json --out RUN.json
//     a recorded scripts/scoreboard.mts result -> a benchmark run (verdicts are the pipeline's self-report)
//   node --experimental-strip-types scripts/benchmark.mts compare --before A.json --after B.json [--tolerance 0]
//     two scorecards of the same task set: exit 1 when a metric got worse (the release regression gate)
//   node --experimental-strip-types scripts/benchmark.mts run --batch BATCH.json [--store STORE.json] [--out DIR]
//     a blinded, equal-budget batch (#397, lib/benchmark/runner.ts): every system's runs, scorecards and one batch report;
//     --store resumes (a run already recorded there is reused, nothing is called again)
//   node --experimental-strip-types scripts/benchmark.mts history
//     the recorded evidence so far, with its denominators
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { evaluateThresholds, fromScoreboardResult, regressions, scorecard, scorecardMarkdown, type BenchmarkRun, type Scorecard, type TaskSet, type ThresholdSet } from '../lib/benchmark/scorecard.ts'
import { batchFromFile, batchMarkdown, memoryStore, runBatch, type BatchFile, type StoredRun } from '../lib/benchmark/runner.ts'

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
} else if (cmd === 'run') {
  const opts = batchFromFile(json<BatchFile>(arg('--batch') ?? die('--batch BATCH.json is required')))
  const storeFile = arg('--store')
  const store = memoryStore()
  if (storeFile && existsSync(storeFile)) for (const r of json<StoredRun[]>(storeFile)) store.put(r)
  const before = store.runs.size
  const r = await runBatch({ ...opts, store, commit: process.env.GITHUB_SHA ?? null })
  if (storeFile) writeFileSync(storeFile, JSON.stringify([...store.runs.values()], null, 2) + '\n')
  const out = arg('--out')
  if (out) {
    mkdirSync(out, { recursive: true })
    writeFileSync(path.join(out, `batch-${r.manifest.batch_id}.json`), JSON.stringify(r, null, 2) + '\n')
    writeFileSync(path.join(out, `batch-${r.manifest.batch_id}.md`), batchMarkdown(r) + '\n')
  }
  process.stdout.write(batchMarkdown(r) + `\n\nruns: ${store.runs.size - before} new, ${before} reused from the store\n`)
} else die('usage: benchmark.mts scorecard|from-scoreboard|compare|run|history (see the header)')
