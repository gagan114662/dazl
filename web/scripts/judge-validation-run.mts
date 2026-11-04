// The real-model judge validation run (#396; lib/evals/judge-validation-run.ts). PAID when given --execute: one capped run of
// both judges over both splits of the synthetic corpus. Without --execute it only checks the inputs and prints the plan and
// its worst-case cost: no key is read and no request is made. The offline stub harness is scripts/judges.mts.
//
//   node --experimental-strip-types --no-warnings scripts/judge-validation-run.mts \
//     --run-id <id> --model claude-sonnet-4-5 --cap-usd <usd> \
//     --fx-cad-per-usd <Bank of Canada rate> --fx-date <YYYY-MM-DD> --fx-source <bankofcanada.ca URL> \
//     --fee-rate <fraction> --fee-basis <billing account fee/tax figure> --state-dir <absolute dir> [--execute]
//
// The key: env DAZL_JUDGE_VALIDATION_ANTHROPIC_KEY only (never a flag). Every input is required; none has a default. The
// model is named by the owner at run time (only claude-sonnet-4-5 is priced). --state-dir is an explicit absolute
// directory for the run markers, the ledger and the redacted result. There is ONE run: no rerun flag exists. The run is
// also claimed on this host (~/.dazl/judge-validation.host-claim) and, once its record is committed, in
// lib/evals/judge-validation-runs.json; any of them refuses a second run.
// Exit: 0 completed, 1 failed (stopped), 2 refused (nothing sent).
import { readFileSync } from 'node:fs'
import { anthropicTransport, parseValidationArgs, preflight, readKeyFromEnv, runValidation, KEY_ENV, type RunInputs } from '../lib/evals/judge-validation-run.ts'
import type { JudgeCorpus } from '../lib/evals/judge.ts'

const corpus = JSON.parse(readFileSync(new URL('../test/fixtures/evals/judges/corpus.synthetic.json', import.meta.url), 'utf8')) as JudgeCorpus
const args = parseValidationArgs(process.argv.slice(2))
const refuse = (problems: string[]): never => { console.error(`judge validation: REFUSED (nothing sent)\n  ${problems.join('\n  ')}`); process.exit(2) }
if (args.problems.length) refuse(args.problems)
const { problems, plan } = preflight(args.inputs, corpus, new Date())
if (problems.length || !plan) refuse(problems)
const i = args.inputs as unknown as RunInputs
console.log(`judge validation plan: corpus ${corpus.id} (synthetic, ${corpus.items.length} items), model ${i.model}`)
for (const [phase, n] of Object.entries(plan!.by_phase)) console.log(`  ${phase}: ${n} calls`)
console.log(`  ${plan!.calls.length} calls, worst case ${(plan!.worst_case_micro / 1e6).toFixed(6)} USD; cap ${i.capUsd} USD = ${(i.capUsd * i.fxCadPerUsd * (1 + i.feeRate)).toFixed(4)} CAD at ${i.fxCadPerUsd} CAD/USD (Bank of Canada, ${i.fxDate}, ${i.fxSource}) + ${i.feeRate * 100}% fees/tax (${i.feeBasis})`)
if (!args.execute) { console.log('\nplan only: no key read, no request made. Add --execute to make the paid run.'); process.exit(0) }

const k = readKeyFromEnv(process.env)
if ('problem' in k) refuse([k.problem])
const key = (k as { key: string }).key
const r = await runValidation(args.inputs, { transport: anthropicTransport(key), secrets: [key], corpus })
if (r.status === 'refused') refuse(r.problems)
if (r.status !== 'refused') {
  const a = r.artifact
  console.log(`\njudge validation: ${a.status.toUpperCase()}${a.stop ? ` (${a.stop.reason})` : ''}`)
  console.log(`  requests ${a.totals.requests}/${a.plan.calls}, committed ${a.totals.committed_usd} USD (settled ${a.totals.settled_usd}, unknown-billing attempts ${a.totals.unknown_billing_attempts}), refusals ${a.totals.refusals}, max_tokens ${a.totals.max_tokens}, served ${a.model.served.join(', ') || '-'}`)
  for (const [judge, splits] of Object.entries(a.results)) for (const [split, p] of Object.entries(splits)) console.log(`  ${judge} / ${split}: ${p.report ? (p.report.ok ? 'pass' : `FAIL: ${p.report.problems.join('; ')}`) : p.note}`)
  console.log(r.artifact_error ? `  RESULT NOT WRITTEN: ${r.artifact_error}` : `  result: ${r.artifact_path}`)
  console.log(`  (${KEY_ENV} was read from the environment and is redacted from every file written)`)
  process.exit(r.status === 'completed' && !r.artifact_error ? 0 : 1)
}
