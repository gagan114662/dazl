// Judge harness (lib/evals/judge.ts, #396): scores the claim judge and the scan's verification judge, each under every
// reference stub model (test/helpers/judge-stubs.ts), on the synthetic adversarial corpus, and checks the harness still has
// teeth: the truthful stub must pass and every adversarial stub must fail. Offline: stub models only, no key, no network.
//   node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts scripts/judges.mts [--holdout] [--json out.json] [--verdicts log.jsonl]
// --verdicts appends this run's answers to a JSON-lines log of stored verdicts and reports drift against the log's first run.
// Exit 1 when a reference stub lands on the wrong side of the gate, or when --verdicts finds drift.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { calibrate, detectDrift, parseStoredVerdicts, toStoredVerdicts, type CalibrationReport, type JudgeCorpus } from '../lib/evals/judge.ts'
import { claimSupportJudge, scanVerificationJudge, STUB_MODELS } from '../test/helpers/judge-stubs.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const corpus = JSON.parse(readFileSync(new URL('../test/fixtures/evals/judges/corpus.synthetic.json', import.meta.url), 'utf8')) as JudgeCorpus
const split = process.argv.includes('--holdout') ? 'holdout' as const : 'calibration' as const
const pct = (x: number | null) => x === null ? '-' : `${Math.round(x * 100)}%`

const rows: { judge: string; stub: string; report: CalibrationReport }[] = []
for (const stub of Object.keys(STUB_MODELS)) {
  rows.push({ judge: 'claim_support', stub, report: await calibrate(claimSupportJudge(corpus, STUB_MODELS[stub](), { id: 'claim_support', version: 1, model: `stub:${stub}`, prompt_version: 1 }), corpus, { split }) })
  rows.push({ judge: 'scan_verification_judge', stub, report: await calibrate(scanVerificationJudge(corpus, STUB_MODELS[stub](), { id: 'scan_verification_judge', version: 1, model: `stub:${stub}`, prompt_version: 1 }), corpus, { split }) })
}
console.log(`judge harness: corpus ${corpus.id} (${corpus.origin.toUpperCase()}, ${split} split), stub models only - not a measurement of any real model\n`)
console.log('judge | stub model | gate | agree | coverage | fp | fn | abstain | flip | group flip | critical fp | calls')
for (const { judge, stub, report: r } of rows) console.log(`${judge} | ${stub} | ${r.ok ? 'pass' : 'FAIL'} | ${pct(r.agreement.agree_rate)} | ${pct(r.agreement.coverage)} | ${pct(r.overall.fp_rate)} | ${pct(r.overall.fn_rate)} | ${pct(r.overall.abstain_rate)} | ${pct(r.stability.flip_rate)} | ${pct(r.stability.group_flip_rate)} | ${r.critical_fp.join(' ') || '-'} | ${r.budget.calls}`)
console.log(`\nlimits:\n  ${[...new Set(rows.flatMap(r => r.report.limits))].join('\n  ')}`)

// The harness's own check: on the calibration split, only the truthful stub may pass.
const wrong = split === 'calibration' ? rows.filter(r => r.report.ok !== (r.stub === 'truthful')) : []
for (const w of wrong) console.log(`\nHARNESS LOST ITS TEETH: ${w.judge} under stub ${w.stub} ${w.report.ok ? 'passed' : `failed: ${w.report.problems.join('; ')}`}`)

let drifted = false
const log = arg('--verdicts')
if (log) {
  const at = new Date().toISOString(), run = `run-${at}`
  appendFileSync(log, rows.filter(r => r.stub === 'truthful').flatMap(r => toStoredVerdicts(r.report, corpus, run, at)).map(x => JSON.stringify(x)).join('\n') + '\n')
  const stored = parseStoredVerdicts(existsSync(log) ? readFileSync(log, 'utf8') : '')
  for (const judge of ['claim_support', 'scan_verification_judge']) for (const d of detectDrift(stored, { judge })) {
    console.log(`\ndrift ${judge} (${d.origin}, ${d.split}): ${d.status}${d.problems.length ? `\n  ${d.problems.join('\n  ')}` : ''}`)
    if (d.status === 'drifted') drifted = true
  }
}
const out = arg('--json')
if (out) writeFileSync(out, JSON.stringify(rows, null, 1))
console.log(wrong.length || drifted ? '\njudge harness: FAIL' : '\njudge harness: ok')
process.exit(wrong.length || drifted ? 1 : 0)
