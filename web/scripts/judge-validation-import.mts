// Turns the result of the one approved judge validation run into what the release gate and the reports read (#784, #785;
// lib/evals/judge-validation-import.ts). No key, no network, no model call.
//
//   node --experimental-strip-types --no-warnings scripts/judge-validation-import.mts --artifact <path to the run's .result.json> [--write]
//
// Without --write it only checks the artifact against the committed claim and says what it would write. With --write it
// writes, in this checkout: the claim's consumption (lib/evals/judge-validation-runs.json), the artifact itself
// (test/fixtures/evals/judges/validation-run.result.json), the stored-verdict log (verdicts.jsonl) and the calibration
// entries of judges.lock.json. Commit them together by a reviewed PR; `npm test` then checks them against the artifact.
// Exit: 0 ok, 2 refused (nothing written).
import { readFileSync, writeFileSync } from 'node:fs'
import { importValidationArtifact, ARTIFACT_FIXTURE, LOCK_FIXTURE, VERDICT_LOG_FIXTURE } from '../lib/evals/judge-validation-import.ts'
import { RUN_RECORD_FILE } from '../lib/evals/judge-validation-run.ts'
import type { JudgeCorpus } from '../lib/evals/judge.ts'

const at = (f: string) => new URL(`../${f}`, import.meta.url)
const i = process.argv.indexOf('--artifact')
const path = i > 0 ? process.argv[i + 1] : undefined
const unknown = process.argv.slice(2).filter((a, k, all) => a !== '--write' && a !== '--artifact' && all[k - 1] !== '--artifact')
if (!path || unknown.length) { console.error(`judge validation import: REFUSED (nothing written)\n  usage: --artifact <result.json> [--write]${unknown.length ? `\n  unknown argument: ${unknown[0].slice(0, 40)}` : ''}`); process.exit(2) }
let artifactText: string
try { artifactText = readFileSync(path, 'utf8') } catch { console.error('judge validation import: REFUSED (nothing written)\n  the artifact file cannot be read'); process.exit(2) }
const corpus = JSON.parse(readFileSync(at('test/fixtures/evals/judges/corpus.synthetic.json'), 'utf8')) as JudgeCorpus
const r = importValidationArtifact({ artifactText, recordText: readFileSync(at(RUN_RECORD_FILE), 'utf8'), lockText: readFileSync(at(LOCK_FIXTURE), 'utf8'), corpus })
if (r.problems.length) { console.error(`judge validation import: REFUSED (nothing written)\n  ${r.problems.join('\n  ')}`); process.exit(2) }
console.log(`judge validation import: run ${r.run_id}, artifact sha256 ${r.artifact_sha256}`)
if (!r.results) console.log('  the run has NO results (it failed or stopped): the claim is consumed, no verdict and no lock entry is written')
for (const e of r.entries!) console.log(`  ${e.judge.id} on ${e.judge.model} (${e.fingerprint.slice(0, 12)}): calibration ${e.ok ? 'ok' : `FAILED: ${e.problems.join('; ')}`}${e.critical_fp.length ? `; critical false positives: ${e.critical_fp.join(', ')}` : ''}`)
if (r.results) console.log(`  ${r.verdicts!.length} stored verdicts (both judges, calibration and holdout)`)
if (!process.argv.includes('--write')) { console.log('checked only: nothing written. Add --write to write the four files.'); process.exit(0) }
writeFileSync(at(RUN_RECORD_FILE), r.recordText!)
writeFileSync(at(ARTIFACT_FIXTURE), artifactText)
writeFileSync(at(LOCK_FIXTURE), r.lockText!)
if (r.verdictLog !== null && r.verdictLog !== undefined) writeFileSync(at(VERDICT_LOG_FIXTURE), r.verdictLog)
console.log(`written: ${RUN_RECORD_FILE} (claim consumed), ${ARTIFACT_FIXTURE}, ${LOCK_FIXTURE}${r.results ? `, ${VERDICT_LOG_FIXTURE}` : ''}\ncommit them together by a reviewed PR; then: scripts/judges.mts --gate and --report ${VERDICT_LOG_FIXTURE}`)
