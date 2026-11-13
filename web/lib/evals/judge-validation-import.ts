// From the one approved real-model validation run (lib/evals/judge-validation-run.ts) to what the release gate and the
// reports read (#784, #785). The run writes a redacted artifact on the machine it ran on and updates nothing else; this
// module turns that artifact into three committed things, and nothing else can produce them:
//   - the claim's consumption in lib/evals/judge-validation-runs.json (artifact_sha256, ended_at): no rerun after it;
//   - the stored-verdict log (test/fixtures/evals/judges/verdicts.jsonl): every item's answer, both judges, both splits;
//   - the judges' calibration entries in test/fixtures/evals/judges/judges.lock.json: one per judge, from its
//     calibration-split report, `ok` exactly as the run measured it (a failed calibration is recorded as failed).
// No network, no key, no model call. It accepts only the artifact of the run the committed claim names: the contract,
// run id, approval, model, corpus, code hashes and the claim's own sha256 must match, and once the claim is consumed the
// artifact's sha256 must be the one recorded. Before that, the operator gives the sha256 the run printed on the machine
// it ran on (expectSha256), and any other artifact is refused.
// A report's summary is not taken at its word: when a claim is consumed (the first import), every report is re-scored.
// The answers it recorded, attempt by attempt, are replayed through the same calibrate() the run used, with the
// runner's fixed repeats, source reversal, thresholds and call budget and the judge's prompt as this checkout's code has
// it, and the result must equal the report in every field (ok, problems, critical false positives, rates, stability,
// fingerprint). An artifact whose ok was set by hand, or whose answers do not give its rates, is refused. The recorded
// answers themselves are bound only by the printed sha256: a file rewritten whole, answers and summary together, is
// stopped by that check and by nothing else, so the reviewer compares it with the run's console output.
// The re-score is repeated on every later import (the CI consistency test) for as long as this checkout's scoring code
// is the code the run used: SCORING_FILES hash the same as the artifact recorded. So an artifact committed with its
// claim consumed by hand, without this importer, is still re-scored by CI while the code is unchanged. Only once that
// code has changed, and the claim is consumed, is the re-score skipped: the recorded artifact_sha256 binds the bytes,
// and a later change to the scoring code or its wording must not turn the one paid result into an error. Residual,
// by that choice: a change that edits the scoring code AND replaces the committed artifact and its recorded sha256 in
// one PR is not re-scored by CI; the review of any PR that touches the artifact or the claim's record is the gate.
// A run that failed or stopped has no results: it consumes the claim and writes no verdict and no lock entry. The artifact is committed beside the log, and test/judge-validation-import.test.ts
// re-derives the log and the lock entries from it on every CI run, so neither can be edited by hand.
// What the entries mean is unchanged: an entry counts for the judge with that exact fingerprint (model included). The
// scan's verification judge is registered as the product runs it (the tenant's own provider), so a calibration of it on
// one named model is recorded here and does not by itself make the registered judge count.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  calibrate, claimJudge, corpusHash, lockEntry, parseStoredVerdicts, toStoredVerdicts,
  type CalibrationReport, type JudgeAdapter, type JudgeCorpus, type JudgeLock, type JudgeLockEntry, type JudgeOutcome, type Split, type StoredVerdict,
} from './judge.ts'
import { APPROVAL, CLAIM_CODE_FILES, FIXED, codeHashes, JUDGE_IDS, KEY_ENV, RUN_RECORD_CONTRACT, SPLITS, STAGING_KEY_ENV, VALIDATION_CONTRACT, judgeSpec, planRun, scanJudgeTemplate, type Artifact, type JudgeId } from './judge-validation-run.ts'

export const ARTIFACT_FIXTURE = 'test/fixtures/evals/judges/validation-run.result.json'
export const VERDICT_LOG_FIXTURE = 'test/fixtures/evals/judges/verdicts.jsonl'
export const LOCK_FIXTURE = 'test/fixtures/evals/judges/judges.lock.json'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
const CONSUMED = ['artifact_sha256', 'ended_at'] as const

// expectSha256: the artifact sha256 the run printed where it ran. Required to consume a claim (the first import); once
// the claim is consumed, the recorded sha256 is the check and this is optional.
// currentCode: sha256 of this checkout's runner code files (codeHashes()); tests pass their own.
export interface ImportInput { artifactText: string; recordText: string; lockText: string; corpus: JudgeCorpus; expectSha256?: string; currentCode?: Record<string, string> }
// The files that decide a report's score: calibrate() and the judges' prompts, and the runner's fixed settings.
export const SCORING_FILES: readonly string[] = Object.freeze(['lib/evals/judge.ts', 'lib/evals/judge-validation-run.ts', 'lib/scan/runner.ts'])
export interface ImportResult {
  problems: string[]
  // Set only when problems is empty. `verdictLog` is null and `entries` empty for a run with no results.
  recordText?: string; lockText?: string; verdictLog?: string | null
  entries?: JudgeLockEntry[]; verdicts?: StoredVerdict[]; artifact_sha256?: string; run_id?: string; results?: boolean
}

// The judge the run asked, as this code builds it (spec and prompt template), answering from the report's own record:
// each ask() returns the next recorded attempt of the item being asked, in the order calibrate() asks them.
function replayAdapter(judge: JudgeId, model: string, report: CalibrationReport, corpus: JudgeCorpus, split: Split): JudgeAdapter {
  const spec = judgeSpec(judge, model)
  const real = judge === 'claim_support' ? claimJudge(spec, async () => '') : null
  const template = real ? real.template : scanJudgeTemplate()
  const items = corpus.items.filter(it => it.split === split)
  let at = 0, attempt = 0
  const ask = async (): Promise<JudgeOutcome> => {
    while (at < items.length && attempt >= (report.items?.[items[at].id]?.attempts?.length ?? 0)) { at++; attempt = 0 }
    const rec = at < items.length ? report.items[items[at].id].attempts[attempt++] : undefined
    // a missing record answers as nothing calibrate() accepts, so the replay cannot equal the report
    return (rec ? { answer: rec.answer, quote: null, source: null, reason: rec.reason } : { answer: 'missing' }) as JudgeOutcome
  }
  return { spec, template, quotes: real ? real.quotes : false, ask }
}
// Re-score one report from its recorded attempts. Null when the replay equals it; otherwise why not.
async function rescore(judge: JudgeId, split: Split, model: string, report: CalibrationReport, corpus: JudgeCorpus): Promise<string | null> {
  let replayed: CalibrationReport
  try {
    replayed = await calibrate(replayAdapter(judge, model, report, corpus, split), corpus, { split, thresholds: { ...FIXED.thresholds }, repeats: FIXED.repeats, reverseSources: FIXED.reverseSources, maxCalls: planRun(corpus, model).by_phase[`${judge}/${split}`] })
  } catch (e) { return `cannot be re-scored: ${e instanceof Error ? e.message : String(e)}` }
  const plain = JSON.parse(JSON.stringify(replayed)) as Record<string, unknown>, given = report as unknown as Record<string, unknown>
  const differs = [...new Set([...Object.keys(plain), ...Object.keys(given)])].filter(k => !isDeepStrictEqual(plain[k], given[k]))
  return differs.length ? `does not follow from its own recorded answers (re-scored, these fields differ: ${differs.join(', ')})` : null
}

// The committed claim with its consumption fields removed: the object the runner hashed into the artifact (claim_sha256).
const preCallClaim = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([k]) => !(CONSUMED as readonly string[]).includes(k)))

export async function importValidationArtifact(i: ImportInput): Promise<ImportResult> {
  const problems: string[] = []
  const fail = (p: string): ImportResult => ({ problems: [...problems, p] })
  if (typeof i?.artifactText !== 'string' || !i.artifactText) return fail('no artifact text')
  let a: Artifact, record: Record<string, unknown>, lock: JudgeLock
  try { a = JSON.parse(i.artifactText) as Artifact } catch { return fail('the artifact is not JSON') }
  try { record = JSON.parse(i.recordText) as Record<string, unknown> } catch { return fail('the run record is not JSON') }
  try { lock = JSON.parse(i.lockText) as JudgeLock } catch { return fail('the judge lock is not JSON') }
  if (!isObj(a) || a.contract !== VALIDATION_CONTRACT) return fail(`the artifact is not a ${VALIDATION_CONTRACT} result`)
  if (!isObj(record) || record.contract !== RUN_RECORD_CONTRACT || !Array.isArray(record.claims)) return fail(`the run record is not a ${RUN_RECORD_CONTRACT} record`)
  if (record.claims.length !== 1 || !isObj(record.claims[0])) return fail(`the run record must hold exactly one claim (it holds ${record.claims.length}): only the claimed run's result can be imported`)
  if (!isObj(lock) || lock.kind !== 'dazl.judge-lock' || !Array.isArray(lock.judges) || !isObj(lock.corpus)) return fail('the judge lock is not a dazl.judge-lock')
  const claim = record.claims[0] as Record<string, unknown>
  const artifact_sha256 = sha(i.artifactText)

  // The artifact is the claimed run's: every binding the runner wrote into it equals the committed claim.
  if (a.run_id !== claim.run_id) problems.push(`the artifact is run ${String(a.run_id).slice(0, 64)}, the claim is for ${String(claim.run_id).slice(0, 64)}`)
  if (a.approval !== APPROVAL || claim.approval !== APPROVAL) problems.push('the artifact or the claim does not carry the approval this run was made under')
  if (!isObj(a.model) || a.model.requested !== claim.model) problems.push('the artifact\'s model is not the claimed model')
  if (!isObj(a.run_guard) || a.run_guard.claim_sha256 !== sha(JSON.stringify(preCallClaim(claim)))) problems.push('the artifact was not made under this claim (claim_sha256 differs)')
  if (!isObj(a.run_guard) || a.run_guard.machine_fingerprint !== claim.machine_fingerprint) problems.push('the artifact was made on another machine than the claim names')
  const code = isObj(a.code) ? a.code : {}, claimed = isObj(claim.code_sha256) ? claim.code_sha256 : {}
  for (const f of CLAIM_CODE_FILES) if (typeof code[f] !== 'string' || code[f] !== claimed[f]) problems.push(`the artifact's code hash for ${f} is not the claimed one`)
  const hasA = Object.hasOwn(claim, 'artifact_sha256'), hasE = Object.hasOwn(claim, 'ended_at')
  if (hasA !== hasE) problems.push('the claim carries only one of artifact_sha256 and ended_at')
  if (hasA && claim.artifact_sha256 !== artifact_sha256) problems.push('the claim is already consumed by another artifact (artifact_sha256 differs): this is not the recorded run\'s result')
  if (hasE && claim.ended_at !== a.ended_at) problems.push('the claim\'s ended_at is not the artifact\'s')
  if (i.expectSha256 !== undefined && i.expectSha256 !== artifact_sha256) problems.push('this is not the artifact the run printed (its sha256 is not the expected one)')
  if (!hasA && i.expectSha256 === undefined) problems.push('the claim is not consumed yet: give the artifact sha256 the run printed where it ran (--expect-sha256), so only that file can consume it')
  if (typeof a.ended_at !== 'string' || Number.isNaN(Date.parse(a.ended_at))) problems.push('the artifact has no valid ended_at')
  // Re-score now? Always when this import consumes the claim; afterwards while the scoring code is still the run's.
  const current = i.currentCode ?? codeHashes()
  // A scoring file that cannot be read is not "the code changed": refuse, never skip the re-score on it.
  for (const f of SCORING_FILES) if (typeof current[f] !== 'string' || !HEX64.test(current[f])) problems.push(`this checkout's ${f} cannot be read, so whether the scoring code is the run's is unknown`)
  const sameScoringCode = SCORING_FILES.every(f => typeof code[f] === 'string' && current[f] === code[f])
  const rescoreNow = !hasA || sameScoringCode
  const keyEnv = isObj(a.run_guard) ? a.run_guard.key_env : undefined
  if (keyEnv !== KEY_ENV && keyEnv !== STAGING_KEY_ENV) problems.push('the artifact does not say which of the two key names paid for the run (run_guard.key_env)')
  if (rescoreNow && (!isObj(a.fixed_before_run) || !isDeepStrictEqual(a.fixed_before_run.thresholds, { ...FIXED.thresholds }) || a.fixed_before_run.repeats !== FIXED.repeats || a.fixed_before_run.reverse_sources !== FIXED.reverseSources)) problems.push('the artifact was not scored with the thresholds, repeats and source reversal fixed in this code')
  // The corpus the run used is the frozen one, and the one given here.
  let hash = ''
  try { hash = corpusHash(i.corpus) } catch { problems.push('the corpus is unreadable') }
  if (!isObj(a.corpus) || a.corpus.hash !== hash || lock.corpus.hash !== hash) problems.push('the artifact, the lock and the corpus do not name the same corpus (hash differs)')
  if (problems.length) return { problems }

  const consumed = { ...preCallClaim(claim), artifact_sha256, ended_at: a.ended_at }
  const recordText = JSON.stringify({ ...record, claims: [consumed] }, null, 1) + '\n'
  const source = `judge validation run ${a.run_id} (${a.model.requested}), artifact sha256 ${artifact_sha256}, ${ARTIFACT_FIXTURE}`
  // No results: a failed or stopped run. Its partial rates are not results; only the consumption is recorded.
  if (a.status !== 'completed' || a.results_valid !== true) {
    return { problems: [], recordText, lockText: JSON.stringify({ ...lock, judges: [] }, null, 1) + '\n', verdictLog: null, entries: [], verdicts: [], artifact_sha256, run_id: a.run_id, results: false }
  }
  const entries: JudgeLockEntry[] = [], verdicts: StoredVerdict[] = []
  try {
    for (const judge of JUDGE_IDS) for (const split of SPLITS) {
      const phase = isObj(a.results) && isObj(a.results[judge]) ? a.results[judge][split] : undefined
      const report = phase?.report as CalibrationReport | null | undefined
      if (!report) { problems.push(`a completed run must report ${judge}/${split}: it has no report`); continue }
      if (report.split !== split || report.judge?.id !== judge || report.judge?.model !== a.model.requested || report.fingerprint !== phase!.fingerprint || !HEX64.test(report.fingerprint) || report.corpus?.hash !== hash) {
        problems.push(`the ${judge}/${split} report is not that judge, split, model and corpus`); continue
      }
      const off = rescoreNow ? await rescore(judge, split, a.model.requested, report, i.corpus) : null
      if (off) { problems.push(`the ${judge}/${split} report ${off}`); continue }
      verdicts.push(...toStoredVerdicts(report, i.corpus, a.run_id, a.ended_at))
      if (split === 'calibration') entries.push(lockEntry(report, a.ended_at, source))
    }
  } catch (e) { problems.push(`the artifact's reports cannot be stored: ${e instanceof Error ? e.message : String(e)}`) }
  if (problems.length) return { problems }
  const verdictLog = verdicts.map(v => JSON.stringify(v)).join('\n') + '\n'
  try { parseStoredVerdicts(verdictLog) } catch (e) { return { problems: [`the verdict log this artifact gives does not parse: ${e instanceof Error ? e.message : String(e)}`] } }
  // There is one approved run, so the lock's calibration entries are exactly this run's: nothing else is carried over.
  const lockText = JSON.stringify({ ...lock, judges: entries }, null, 1) + '\n'
  return { problems: [], recordText, lockText, verdictLog, entries, verdicts, artifact_sha256, run_id: a.run_id, results: true }
}
