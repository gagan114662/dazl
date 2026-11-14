// The real-model judge validation run (#396; lib/evals/judge-validation-run.ts). PAID when given --execute: one capped run of
// both judges over both splits of the synthetic corpus. Without --execute it only checks the inputs and prints the plan and
// its worst-case cost: no key is read and no request is made. The offline stub harness is scripts/judges.mts.
//
//   node --experimental-strip-types --no-warnings scripts/judge-validation-run.mts \
//     --run-id <id> --model claude-sonnet-4-5 --cap-usd <usd> \
//     --fx-cad-per-usd <Bank of Canada rate> --fx-date <YYYY-MM-DD> --fx-source <bankofcanada.ca URL> \
//     --fee-rate <fraction> --fee-basis <billing account fee/tax figure> [--state-dir <absolute dir>] [--execute]
//
// The key: env DAZL_JUDGE_VALIDATION_ANTHROPIC_KEY (never a flag); with DAZL_ENV=staging and that name unset, the key
// staging already holds, DAZL_TRIAL_ANTHROPIC_KEY. No other name is read. Every input is required; none has a default except
// the state directory. The model is named by the owner at run time (only claude-sonnet-4-5 is priced). The state directory
// (the run markers, the ledger and the redacted result) is --state-dir, else env DAZL_JUDGE_VALIDATION_STATE_DIR, else
// <home of the running user>/.dazl/judge-validation: under the user's own home, created mkdir -p mode 0700 by --execute only
// (plan-only writes nothing), refused when it is not private. No root, no /etc, no /var/lib. The committed claim binds the exact path. There is ONE run: no rerun flag exists.
// --execute refuses unless lib/evals/judge-validation-runs.json holds exactly one reviewed pre-call claim that matches this
// machine (its fingerprint), every input above, the state dir and the runner's code hashes, unexpired and unconsumed. The
// plan-only output prints that claim for review. The run is then claimed locally (~/.dazl/judge-validation.host-claim and
// the state dir) before the first request. After the run, record its artifact_sha256 and ended_at in the claim by a PR.
// Exit: 0 completed, 1 failed (stopped), 2 refused (nothing sent).
import { readFileSync } from 'node:fs'
import { anthropicTransport, claimStatus, defaultStateDir, parseValidationArgs, preflight, readKeyFromEnv, runValidation, RUN_RECORD_FILE, type RunInputs } from '../lib/evals/judge-validation-run.ts'
import type { JudgeCorpus } from '../lib/evals/judge.ts'

const corpus = JSON.parse(readFileSync(new URL('../test/fixtures/evals/judges/corpus.synthetic.json', import.meta.url), 'utf8')) as JudgeCorpus
const args = parseValidationArgs(process.argv.slice(2))
if (!args.problems.length && args.inputs.stateDir === undefined) args.inputs.stateDir = defaultStateDir(process.env)
const refuse = (problems: string[]): never => { console.error(`judge validation: REFUSED (nothing sent)\n  ${problems.join('\n  ')}`); process.exit(2) }
if (args.problems.length) refuse(args.problems)
const { problems, plan } = preflight(args.inputs, corpus, new Date())
if (problems.length || !plan) refuse(problems)
const i = args.inputs as unknown as RunInputs
console.log(`judge validation plan: corpus ${corpus.id} (synthetic, ${corpus.items.length} items), model ${i.model}`)
for (const [phase, n] of Object.entries(plan!.by_phase)) console.log(`  ${phase}: ${n} calls`)
console.log(`  ${plan!.calls.length} calls, worst case ${(plan!.worst_case_micro / 1e6).toFixed(6)} USD; cap ${i.capUsd} USD = ${(i.capUsd * i.fxCadPerUsd * (1 + i.feeRate)).toFixed(4)} CAD at ${i.fxCadPerUsd} CAD/USD (Bank of Canada, ${i.fxDate}, ${i.fxSource}) + ${i.feeRate * 100}% fees/tax (${i.feeBasis})`)
if (!args.execute) {
  // Reads only (machine id, code files, the committed record); writes nothing.
  const cs = claimStatus(i, new Date())
  if (cs.claim) console.log(`\nthe pre-call claim this run needs in ${RUN_RECORD_FILE} (commit it by a reviewed PR; shorten expires_at as wanted):\n${JSON.stringify(cs.claim, null, 1)}`)
  console.log(cs.problems.length ? `\n--execute would refuse now:\n  ${cs.problems.join('\n  ')}` : '\nthe committed record holds this claim')
  console.log('\nplan only: no key read, no request made, nothing written. Add --execute to make the paid run.')
  process.exit(0)
}

const k = readKeyFromEnv(process.env)
if ('problem' in k) refuse([k.problem])
const { key, name: keyName } = k as { key: string; name: string }
console.log(`key read from ${keyName} (the name only; the value is never printed)`)
const r = await runValidation(args.inputs, { transport: anthropicTransport(key), secrets: [key], corpus, keyEnv: keyName })
if (r.status === 'refused') refuse(r.problems)
if (r.status !== 'refused') {
  const a = r.artifact
  console.log(`\njudge validation: ${a.status.toUpperCase()}${a.stop ? ` (${a.stop.reason})` : ''}`)
  console.log(`  requests ${a.totals.requests}/${a.plan.calls}, committed ${a.totals.committed_usd} USD (settled ${a.totals.settled_usd}, unknown-billing attempts ${a.totals.unknown_billing_attempts}), refusals ${a.totals.refusals}, max_tokens ${a.totals.max_tokens}, served ${a.model.served.join(', ') || '-'}`)
  for (const [judge, splits] of Object.entries(a.results)) for (const [split, p] of Object.entries(splits)) console.log(`  ${judge} / ${split}: ${p.report ? (p.report.ok ? 'pass' : `FAIL: ${p.report.problems.join('; ')}`) : p.note}`)
  console.log(r.artifact_error ? `  RESULT NOT WRITTEN: ${r.artifact_error}` : `  result: ${r.artifact_path} (sha256 ${r.artifact_sha256})`)
  console.log(`  consume the claim: add "artifact_sha256" and "ended_at": "${a.ended_at}" to it in ${RUN_RECORD_FILE} by a reviewed PR`)
  console.log(`  (${keyName} was read from the environment and is redacted from every file written)`)
  if (!r.artifact_error) console.log(`  then, in a checkout of main (no key, no network): scripts/judge-validation-import.mts --artifact <a copy of ${r.artifact_path}> --expect-sha256 ${r.artifact_sha256} --write`)
  process.exit(r.status === 'completed' && !r.artifact_error ? 0 : 1)
}
