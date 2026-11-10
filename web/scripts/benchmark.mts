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
//     BATCH.json is either a synthetic batch file (outputs inline, judged by labels or by the verifier over synthetic
//     snapshots), or a recorded batch (lib/benchmark/recorded.ts: format dazl-benchmark-recorded-batch) naming one
//     recording per system and the verifier's own snapshots; every system of ../scoreboard/benchmark/adapters.json is in
//     it, and one without an owner authorization is unavailable. A recorded batch is always judged by the verifier.
//   node --experimental-strip-types scripts/benchmark.mts dazl-recording --result ../scoreboard/results/<file>.json --out REC.json
//     a recorded scripts/scoreboard.mts result -> the dazl recording a recorded batch replays (task set v1)
//   node --experimental-strip-types scripts/benchmark.mts superiority --plan PLAN.json --hash HASH --ledger LOOKS.json --batches A.json,B.json,...
//     repeated-run paired comparison (#398, lib/benchmark/superiority.ts) against a plan registered (hashed) before the
//     results; LOOKS.json counts looks and the stop rule refuses past max_looks. Prints the plan hash with --hash-only.
//     The first look needs --new-ledger (a missing ledger is never silently a fresh one; an existing one is never reset).
//     cluster_by brief|account needs --clusters MAP.json ({ task_id: cluster }). Keep the plan and its ledger committed
//     (scoreboard/benchmark/prereg/<plan id>/): git history is the audit trail of every look.
//   node --experimental-strip-types scripts/benchmark.mts history
//     the recorded evidence so far, with its denominators
// Exit codes: 0 ok; 1 a regression (compare); 2 usage or invalid_input. Invalid input (a file that is truncated or not
// JSON, a run that is not a dazl-benchmark-run, no frozen task set for its version, a duplicate or unknown task id,
// ... see inputProblems in lib/benchmark/scorecard.ts) prints every problem, writes no card and exits 2: it is never
// scored partially.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { evaluateThresholds, fromScoreboardResult, inputProblems, problemSummary, regressions, scorecard, scorecardMarkdown, type BenchmarkRun, type InvalidScorecard, type Scorecard, type TaskSet, type ThresholdSet } from '../lib/benchmark/scorecard.ts'
import { batchFromFile, batchMarkdown, BenchmarkRunError, memoryStore, runBatch, type BatchFile, type BatchResult, type StoredRun } from '../lib/benchmark/runner.ts'
import { dazlRecordingFromScoreboard, RECORDED_BATCH_FORMAT, recordedBatch, type RecordedNote } from '../lib/benchmark/recorded.ts'
import { analyze, checkPrereg, preregHash, PreregError, type LookLedger, type Prereg } from '../lib/benchmark/superiority.ts'

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
} else if (cmd === 'superiority') {
  const refuse = (e: unknown): never => e instanceof PreregError ? die(`invalid_input: ${e.message}`) : (() => { throw e })()
  const raw = json<unknown>(arg('--plan') ?? die('--plan PLAN.json is required'))
  let plan: Prereg
  try { plan = checkPrereg(raw) } catch (e) { refuse(e) }
  if (process.argv.includes('--hash-only')) { console.log(preregHash(plan!)); process.exit(0) }
  const lf = arg('--ledger') ?? die('--ledger LOOKS.json is required')
  const fresh = process.argv.includes('--new-ledger')
  if (existsSync(lf) && fresh) die(`invalid_input: ${lf} exists: a ledger is never reset (--new-ledger is for the first look only)`)
  if (!existsSync(lf) && !fresh) die(`invalid_input: no ledger at ${lf}: pass --new-ledger for the plan's first look`)
  const ledger = fresh ? { plan_hash: preregHash(plan!), looks: [] } : json<LookLedger>(lf)
  const batches = (arg('--batches') ?? die('--batches A.json,B.json is required')).split(',').map(f => json<BatchResult>(f))
  const cm = arg('--clusters')
  const clusters = cm ? json<unknown>(cm) : undefined
  if (clusters !== undefined && !isObj(clusters)) die('invalid_input: --clusters must be a JSON object { task_id: cluster }')
  const clusterOf = clusters ? (t: string) => { const c = (clusters as Record<string, unknown>)[t]; return typeof c === 'string' ? c : '' } : undefined
  let s: ReturnType<typeof analyze>
  try { s = analyze(plan!, arg('--hash') ?? die('--hash (the plan hash registered before the results) is required'), ledger, batches, { clusterOf }) } catch (e) { refuse(e) }
  // the look is written (atomically) before the result is printed: a result is never seen without its look on record
  writeFileSync(lf + '.tmp', JSON.stringify(ledger, null, 2) + '\n'); renameSync(lf + '.tmp', lf)
  console.log(JSON.stringify(s!, null, 2))
} else if (cmd === 'history') {
  const h = json<{ note: string; observations: { date: string; source: string; commit: string | null; request: string; counts: Record<string, number>; note?: string }[] }>(path.join(dir, 'history.json'))
  console.log(h.note + '\n')
  for (const o of h.observations) console.log(`${o.date}  ${o.request}  [${o.source}${o.commit ? `, ${o.commit}` : ''}]  ${Object.entries(o.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(no counts)'}${o.note ? `  - ${o.note}` : ''}`)
} else if (cmd === 'dazl-recording') {
  const file = arg('--result') ?? die('--result FILE is required'), out = arg('--out') ?? die('--out REC.json is required')
  let rec: ReturnType<typeof dazlRecordingFromScoreboard>
  try { rec = dazlRecordingFromScoreboard(json<unknown>(file), taskSet('1')) } catch (e) { if (e instanceof BenchmarkRunError) die(`invalid_input: ${e.message}; nothing written`); throw e }
  writeFileSync(out, JSON.stringify(rec, null, 2) + '\n')
  console.log(`benchmark: dazl recording of ${Object.keys(rec.tasks).length} task(s) from ${path.basename(file)} -> ${out}`)
} else if (cmd === 'run') {
  const batchFile = arg('--batch') ?? die('--batch BATCH.json is required')
  const batch = json<BatchFile & { format?: unknown; task_set_version?: unknown }>(batchFile)
  const committedOf = (v: string) => { const f = path.join(dir, `v${v}`, 'tasks.json'); return /^[\w.-]+$/.test(v) && existsSync(f) ? json<TaskSet>(f) : null }
  let opts: ReturnType<typeof batchFromFile>, committedSet: TaskSet | null, notes: RecordedNote[] = []
  if (isObj(batch) && batch.format === RECORDED_BATCH_FORMAT) {
    // a recorded batch: the committed task set, the committed adapter registry, and files named relative to the batch
    committedSet = committedOf(String(batch.task_set_version))
    const base = path.dirname(path.resolve(batchFile))
    try { const rb = recordedBatch(batch, { registry: json<unknown>(path.join(dir, 'adapters.json')), committedSet, read: f => json<unknown>(path.resolve(base, f)) }); opts = rb.options; notes = rb.notes } catch (e) { if (e instanceof BenchmarkRunError) die(`invalid_input: ${e.message}; nothing run`); throw e }
  } else {
    if (!isObj(batch) || !isObj(batch.task_set)) die('invalid_input: the batch file has no task_set')
    try { opts = batchFromFile(batch) } catch (e) { if (e instanceof BenchmarkRunError) die(`invalid_input: ${e.message}`); throw e }
    // the committed frozen task set for this version, if there is one: the batch must run it unchanged
    committedSet = committedOf(String(batch.task_set.version))
  }
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
  process.stdout.write(batchMarkdown(r) + `${notes.length ? `\n\n${notes.map(n => `- ${n.system}: ${n.used ? 'recording replayed' : n.reason}`).join('\n')}` : ''}\n\nruns: ${store.runs.size - before} new, ${before} reused from the store\n`)
} else die('usage: benchmark.mts scorecard|from-scoreboard|compare|run|dazl-recording|superiority|history (see the header)')
