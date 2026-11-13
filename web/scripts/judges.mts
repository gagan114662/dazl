// Judge harness (lib/evals/judge.ts, #396): scores the claim judge and the scan's verification judge, each under every
// reference stub model (test/helpers/judge-stubs.ts), on the frozen synthetic adversarial corpus, and checks the harness
// still has teeth: the truthful stub must pass and every adversarial stub must fail. Offline: stub models only, no key, no
// network.
//   node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts scripts/judges.mts [--holdout] [--json out.json] [--verdicts log.jsonl] [--gate [--lock lock.json] [--verdict-log log.jsonl]] [--report log.jsonl]
// --verdicts appends this run's answers (truthful stub) to a JSON-lines log of stored verdicts and reports drift against
//   the log's first run. The existing log is read and validated first, together with the new run; when either fails, the
//   file is left exactly as it was (a v1 log is refused, not migrated: it has no judge version to migrate from).
// --gate runs the release gate (#784) on the judges the code runs, exactly as test/judge-release-gate.test.ts does in CI:
//   on the committed lock and the committed stored-verdict log (test/fixtures/evals/judges/verdicts.jsonl, absent while
//   no real model is calibrated), whose drift it checks. --lock and --verdict-log point it at other files.
// --report prints a stored-verdict log per judge version and per condition (#785), without running any judge.
// Exit 1 when a reference stub lands on the wrong side of the gate, when --verdicts finds drift or cannot append, when
// --gate blocks, or when --report finds runs it cannot compare.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import {
  assertFrozen, calibrate, detectDrift, parseStoredVerdicts, releaseGate, renderCalibration, renderVerdictHistory, toStoredVerdicts, verdictHistory,
  type CalibrationReport, type JudgeCorpus, type JudgeLock,
} from '../lib/evals/judge.ts'
import { claimSupportJudge, readVerdictLog, releaseInputs, scanVerificationJudge, STUB_MODELS, VERDICT_LOG } from '../test/helpers/judge-stubs.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const dir = new URL('../test/fixtures/evals/judges/', import.meta.url)
const lock = JSON.parse(readFileSync(arg('--lock') ?? new URL('judges.lock.json', dir), 'utf8')) as JudgeLock
const corpus = assertFrozen(JSON.parse(readFileSync(new URL('corpus.synthetic.json', dir), 'utf8')) as JudgeCorpus, lock.corpus)
const split = process.argv.includes('--holdout') ? 'holdout' as const : 'calibration' as const
const pct = (x: number | null) => x === null ? '-' : `${Math.round(x * 100)}%`
const JUDGE_IDS = ['claim_support', 'scan_verification_judge']

const reportLog = arg('--report')
if (reportLog) {
  const stored = parseStoredVerdicts(readFileSync(reportLog, 'utf8'))
  let invalid = false
  for (const judge of JUDGE_IDS) { const h = verdictHistory(stored, { judge }); if (h.length) console.log(renderVerdictHistory(h) + '\n'); invalid ||= h.some(x => x.problems.length > 0) }
  process.exit(invalid ? 1 : 0)
}

const rows: { judge: string; stub: string; report: CalibrationReport }[] = []
for (const stub of Object.keys(STUB_MODELS)) {
  rows.push({ judge: 'claim_support', stub, report: await calibrate(claimSupportJudge(corpus, STUB_MODELS[stub](), { id: 'claim_support', version: 1, model: `stub:${stub}`, prompt_version: 1 }), corpus, { split }) })
  rows.push({ judge: 'scan_verification_judge', stub, report: await calibrate(scanVerificationJudge(corpus, STUB_MODELS[stub](), { id: 'scan_verification_judge', version: 1, model: `stub:${stub}`, prompt_version: 1 }), corpus, { split }) })
}
console.log(`judge harness: corpus ${corpus.id} (${corpus.origin.toUpperCase()}, ${split} split, frozen), stub models only - not a measurement of any real model\n`)
console.log('judge | stub model | gate | agree | coverage | fp | fn | abstain | flip | group flip | critical fp | calls')
for (const { judge, stub, report: r } of rows) console.log(`${judge} | ${stub} | ${r.ok ? 'pass' : 'FAIL'} | ${pct(r.agreement.agree_rate)} | ${pct(r.agreement.coverage)} | ${pct(r.overall.fp_rate)} | ${pct(r.overall.fn_rate)} | ${pct(r.overall.abstain_rate)} | ${pct(r.stability.flip_rate)} | ${pct(r.stability.group_flip_rate)} | ${r.critical_fp.join(' ') || '-'} | ${r.budget.calls}`)
console.log('\nper condition (truthful stub):')
for (const { report } of rows.filter(r => r.stub === 'truthful')) console.log(renderCalibration(report))
console.log(`\nlimits:\n  ${[...new Set(rows.flatMap(r => r.report.limits))].join('\n  ')}`)

// The harness's own check: on the calibration split, only the truthful stub may pass.
const wrong = split === 'calibration' ? rows.filter(r => r.report.ok !== (r.stub === 'truthful')) : []
for (const w of wrong) console.log(`\nHARNESS LOST ITS TEETH: ${w.judge} under stub ${w.stub} ${w.report.ok ? 'passed' : `failed: ${w.report.problems.join('; ')}`}`)

let drifted = false
const log = arg('--verdicts')
if (log) {
  const at = new Date().toISOString(), run = `run-${at}`
  const before = readVerdictLog(log) ?? ''
  const added = rows.filter(r => r.stub === 'truthful').flatMap(r => toStoredVerdicts(r.report, corpus, run, at)).map(x => JSON.stringify(x)).join('\n') + '\n'
  const sep = before && !before.endsWith('\n') ? '\n' : ''
  let stored
  try {
    parseStoredVerdicts(before)
    stored = parseStoredVerdicts(before + sep + added)
  } catch (e) {
    console.log(`\nverdict log ${log} left unchanged: ${(e as Error).message}`)
    process.exit(1)
  }
  appendFileSync(log, sep + added)
  for (const judge of JUDGE_IDS) for (const d of detectDrift(stored, { judge })) {
    console.log(`\ndrift ${judge} (${d.origin}, ${d.split}): ${d.status}${d.problems.length ? `\n  ${d.problems.join('\n  ')}` : ''}`)
    if (d.status !== 'stable' && d.status !== 'insufficient') drifted = true
  }
}

let blocked = false
if (process.argv.includes('--gate')) {
  const decision = releaseGate({ lock, corpus, judges: await releaseInputs(corpus), verdicts: readVerdictLog(arg('--verdict-log') ?? VERDICT_LOG) })
  console.log(`\nrelease gate: ${decision.release.toUpperCase()} (corpus ${decision.corpus.id}, frozen: ${decision.corpus.frozen})`)
  for (const j of decision.judges) console.log(`  ${j.id} ${j.fingerprint.slice(0, 12)}${j.changed ? ' CHANGED' : ''}: harness ${j.harness.map(h => `${h.stub}=${h.ok ? 'pass' : 'fail'}`).join(' ')}; verdicts count: ${j.real_model.usable}`)
  for (const b of decision.blocks) console.log(`  BLOCK: ${b}`)
  for (const l of decision.limits) console.log(`  limit: ${l}`)
  blocked = decision.release === 'blocked'
}
const out = arg('--json')
if (out) writeFileSync(out, JSON.stringify(rows, null, 1))
const fail = wrong.length || drifted || blocked
console.log(fail ? '\njudge harness: FAIL' : '\njudge harness: ok')
process.exit(fail ? 1 : 0)
