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
// Exit codes: 0 ok; 1 a regression (compare); 2 usage or invalid_input. Invalid input (a file that is truncated or not
// JSON, a run that is not a dazl-benchmark-run, no frozen task set for its version, a duplicate or unknown task id,
// ... see inputProblems in lib/benchmark/scorecard.ts) prints every problem, writes no card and exits 2: it is never
// scored partially.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { evaluateThresholds, fromScoreboardResult, inputProblems, problemSummary, regressions, scorecard, scorecardMarkdown, type BenchmarkRun, type InvalidScorecard, type Scorecard, type TaskSet, type ThresholdSet } from '../lib/benchmark/scorecard.ts'
import { batchFromFile, batchMarkdown, BenchmarkRunError, memoryStore, runBatch, type BatchFile, type StoredRun } from '../lib/benchmark/runner.ts'

const dir = path.resolve(import.meta.dirname, '..', '..', 'scoreboard', 'benchmark')
const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
function die(m: string, code = 2): never { console.error(`benchmark: ${m}`); process.exit(code) }
const json = <T,>(f: string): T => {
  let text: string
  try { text = readFileSync(f, 'utf8') } catch (e) { return die(`invalid_input: cannot read ${f}: ${(e as Error).message}`) }
  try { return JSON.parse(text) as T } catch (e) { return die(`invalid_input: ${f} is not valid JSON (truncated or malformed): ${(e as Error).message}`) }
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const taskSet = (v: unknown): TaskSet => {
  if (typeof v !== 'string' || !/^[\w.-]+$/.test(v)) return die(`invalid_input: run.task_set_version ${v === undefined ? 'missing' : JSON.stringify(v)} is not a task set version`)
  const f = path.join(dir, `v${v}`, 'tasks.json')
  return existsSync(f) ? json<TaskSet>(f) : die(`invalid_input: no frozen task set v${v} (${f})`)
}
const scoredCard = (f: string): Scorecard => {
  const c = json<Scorecard | InvalidScorecard>(f)
  if (!isObj(c) || c.format !== 'dazl-benchmark-scorecard') return die(`invalid_input: ${f} is not a benchmark scorecard`)
  if (c.status !== 'scored') return die(`invalid_input: ${f} is not a scored card (status ${JSON.stringify(c.status)})`)
  return c
}
const cmd = process.argv[2]

if (cmd === 'scorecard') {
  const file = arg('--run') ?? die('--run RUN.json is required'), run = json<BenchmarkRun>(file)
  if (!isObj(run)) die(`invalid_input: ${file} is not a benchmark run object`)
  const card = scorecard(taskSet(run.task_set_version), run)
  const th = process.argv.includes('--thresholds') ? evaluateThresholds(card, json<ThresholdSet>(path.join(dir, 'proposed-thresholds.json'))) : undefined
  const md = scorecardMarkdown(card, th)
  if (card.status === 'invalid_input') { process.stdout.write(md); die(`invalid_input: ${file}: ${card.problems.length} problem(s): ${problemSummary(card.problems)}; nothing scored, no card written`) }
  const out = arg('--out')
  if (out) {
    mkdirSync(out, { recursive: true })
    const base = path.join(out, `${card.system}-${card.commit ?? 'nocommit'}-v${card.task_set_version}`)
    writeFileSync(`${base}.json`, JSON.stringify({ ...card, thresholds: th ?? null }, null, 2) + '\n'); writeFileSync(`${base}.md`, md)
  }
  process.stdout.write(md)
} else if (cmd === 'from-scoreboard') {
  const file = arg('--result') ?? die('--result FILE is required'), out = arg('--out') ?? die('--out RUN.json is required')
  const sb = json<Parameters<typeof fromScoreboardResult>[0]>(file)
  if (!isObj(sb) || !Array.isArray(sb.rows) || typeof sb.date !== 'string') die(`invalid_input: ${file} is not a scoreboard result (needs date and rows)`)
  const set = taskSet('1'), run = fromScoreboardResult(sb, set, path.basename(file))
  const problems = inputProblems(set, run)
  if (problems.length) die(`invalid_input: ${file} does not convert to a run on task set v${set.version}: ${problems.map(p => `${p.code}${p.task_id ? ` ${p.task_id}` : ''}: ${p.detail}`).join('; ')}; nothing written`)
  writeFileSync(out, JSON.stringify(run, null, 2) + '\n')
  console.log(`benchmark: ${run.tasks.length} task(s) from ${path.basename(file)} -> ${out} (evaluator: pipeline self-report, not independent)`)
} else if (cmd === 'compare') {
  const a = scoredCard(arg('--before') ?? die('--before is required')), b = scoredCard(arg('--after') ?? die('--after is required'))
  const r = regressions(a, b, Number(arg('--tolerance') ?? 0))
  if (r.length) { console.log(`benchmark: ${r.length} regression(s)\n${r.map(x => `  ${x}`).join('\n')}`); process.exit(1) }
  console.log('benchmark: no regression')
} else if (cmd === 'history') {
  const h = json<{ note: string; observations: { date: string; source: string; commit: string | null; request: string; counts: Record<string, number>; note?: string }[] }>(path.join(dir, 'history.json'))
  console.log(h.note + '\n')
  for (const o of h.observations) console.log(`${o.date}  ${o.request}  [${o.source}${o.commit ? `, ${o.commit}` : ''}]  ${Object.entries(o.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(no counts)'}${o.note ? `  - ${o.note}` : ''}`)
} else if (cmd === 'run') {
  const batch = json<BatchFile>(arg('--batch') ?? die('--batch BATCH.json is required'))
  if (!isObj(batch) || !isObj(batch.task_set)) die('invalid_input: the batch file has no task_set')
  let opts: ReturnType<typeof batchFromFile>
  try { opts = batchFromFile(batch) } catch (e) { if (e instanceof BenchmarkRunError) die(`invalid_input: ${e.message}`); throw e }
  // the committed frozen task set for this version, if there is one: the batch must run it unchanged
  const v = String(batch.task_set.version), committedFile = path.join(dir, `v${v}`, 'tasks.json')
  const committedSet = /^[\w.-]+$/.test(v) && existsSync(committedFile) ? json<TaskSet>(committedFile) : null
  const storeFile = arg('--store')
  const store = memoryStore()
  if (storeFile && existsSync(storeFile)) for (const r of json<StoredRun[]>(storeFile)) store.put(r)
  const before = store.runs.size
  // durable: every recorded run is written at once, so an interrupted batch resumes where it stopped
  const durable = { get: store.get, put: (x: StoredRun) => { store.put(x); if (storeFile) writeFileSync(storeFile, JSON.stringify([...store.runs.values()], null, 2) + '\n') } }
  let r: Awaited<ReturnType<typeof runBatch>>
  try { r = await runBatch({ ...opts, store: durable, committedSet, commit: process.env.GITHUB_SHA ?? null }) } catch (e) { if (e instanceof BenchmarkRunError) die(`invalid_input: ${e.message}; nothing run`); throw e }
  const out = arg('--out')
  if (out) {
    mkdirSync(out, { recursive: true })
    writeFileSync(path.join(out, `batch-${r.manifest.batch_id}.json`), JSON.stringify(r, null, 2) + '\n')
    writeFileSync(path.join(out, `batch-${r.manifest.batch_id}.md`), batchMarkdown(r) + '\n')
  }
  process.stdout.write(batchMarkdown(r) + `\n\nruns: ${store.runs.size - before} new, ${before} reused from the store\n`)
} else die('usage: benchmark.mts scorecard|from-scoreboard|compare|run|history (see the header)')
