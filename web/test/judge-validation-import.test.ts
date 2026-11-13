// #784 #785: from the one approved real-model validation run to what the release gate and the reports read
// (lib/evals/judge-validation-import.ts). Offline: the "model" is a counted stub transport in the Messages API envelope
// (test/helpers/judge-stubs.ts), the key is a dummy and the net fence blocks everything but loopback. The run itself is
// the real runner (runValidation) under a real pre-call claim, so the artifact imported here is byte for byte what the
// paid run writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectDrift, parseStoredVerdicts, releaseGate, renderVerdictHistory, verdictHistory, type JudgeCorpus, type JudgeLock } from '../lib/evals/judge.ts'
import {
  checkClaims, claimFor, codeHashes, fingerprintOf, readKeyFromEnv, runValidation,
  APPROVAL, CLAIM_CODE_FILES, KEY_ENV, RUN_RECORD_CONTRACT, STAGING_KEY_ENV,
  type RunDeps, type RunInputs, type TransportRequest, type TransportResponse,
} from '../lib/evals/judge-validation-run.ts'
import { importValidationArtifact, ARTIFACT_FIXTURE, LOCK_FIXTURE, VERDICT_LOG_FIXTURE } from '../lib/evals/judge-validation-import.ts'
import { claimCall, releaseInputs, scanCall, STUB_MODELS } from './helpers/judge-stubs.ts'

const WEB = new URL('../', import.meta.url)
const read = (f: string) => readFileSync(new URL(f, WEB), 'utf8')
const CORPUS = JSON.parse(read('test/fixtures/evals/judges/corpus.synthetic.json')) as JudgeCorpus
const LOCK_TEXT = read(LOCK_FIXTURE)
const MODEL = 'claude-sonnet-4-5'
const KEY = `sk-ant-dummy-not-a-secret-${'k'.repeat(24)}`
const NOW = new Date('2026-11-04T12:00:00Z'), CREATED = new Date(NOW.getTime() - 3_600_000)
const FP = fingerprintOf('11111111-2222-3333-4444-555555555555')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const tmp = () => mkdtempSync(join(tmpdir(), 'dazl-jvi-'))
const inputs = (stateDir: string, runId = 'val-1'): RunInputs => ({ runId, model: MODEL, capUsd: 3, fxCadPerUsd: 1.4, fxDate: '2026-11-03', fxSource: 'https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/', feeRate: 0.13, feeBasis: 'Anthropic console invoice: 13% HST, card FX fee 0', stateDir })
const reply = (text: string, req: TransportRequest): TransportResponse => ({ status: 200, body: new TextEncoder().encode(JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: Math.ceil(Buffer.byteLength(req.prompt) / 4), output_tokens: Math.min(req.maxTokens, Math.max(1, Math.ceil(text.length / 4))) } })) })

// One run of the real runner under a committed claim, with a stub model. failAt: the request that gets an HTTP 500.
async function run(o: { model?: keyof typeof STUB_MODELS; failAt?: number; runId?: string; keyEnv?: string } = {}) {
  const dir = tmp(), inp = inputs(dir, o.runId)
  const claim = claimFor(inp, FP, codeHashes(), CREATED)
  const record = join(tmp(), 'runs.json')
  const recordText = JSON.stringify({ contract: RUN_RECORD_CONTRACT, note: 'test', claims: [claim] })
  writeFileSync(record, recordText)
  const claimA = claimCall(CORPUS, STUB_MODELS[o.model ?? 'truthful']()), scanA = scanCall(CORPUS, STUB_MODELS[o.model ?? 'truthful']())
  let n = 0
  const transport: RunDeps['transport'] = async req => {
    n++
    if (o.failAt === n) return { status: 500, body: new TextEncoder().encode('{}') }
    return reply(req.prompt.startsWith('You check whether public sources') ? await claimA(req.prompt) : await scanA(req.prompt), req)
  }
  const r = await runValidation(inp, { transport, secrets: [KEY], corpus: CORPUS, now: () => NOW, hostClaim: join(tmp(), 'host-claim'), machineFingerprint: () => FP, runRecord: record, keyEnv: o.keyEnv ?? STAGING_KEY_ENV })
  assert.notEqual(r.status, 'refused', JSON.stringify(r.problems))
  const file = readdirSync(join(dir, 'runs')).find(x => x.endsWith('.result.json'))!
  const artifactText = readFileSync(join(dir, 'runs', file), 'utf8')
  assert.equal(artifactText.includes(KEY), false, 'the key is not in the artifact')
  return { artifactText, recordText, claim, inp, requests: n, printedSha: r.status === 'refused' ? null : r.artifact_sha256 }
}
// expect: the sha256 the run printed (by default this artifact's own); null = not given
const imp = (x: { artifactText: string; recordText: string }, lockText = LOCK_TEXT, expect: string | null = sha(x.artifactText)) =>
  importValidationArtifact({ artifactText: x.artifactText, recordText: x.recordText, lockText, corpus: CORPUS, ...(expect === null ? {} : { expectSha256: expect }) })
type Imported = Awaited<ReturnType<typeof imp>>

test('#784 #785 a completed run imports into the claim\'s consumption, a stored-verdict log of every answer and one calibration entry per judge; the gate then counts the claim judge and the report shows both judges per condition', async () => {
  const x = await run()
  const r = await imp(x)
  assert.deepEqual(r.problems, [])
  assert.equal(r.results, true); assert.equal(r.artifact_sha256, sha(x.artifactText)); assert.equal(r.artifact_sha256, x.printedSha, 'the sha the run printed')
  assert.equal(JSON.parse(x.artifactText).run_guard.key_env, STAGING_KEY_ENV, 'the artifact names the variable the key came from, never the key')
  assert.equal(JSON.parse((await run({ keyEnv: 'ANTHROPIC_API_KEY' })).artifactText).run_guard.key_env, null, 'any other name is not recorded')
  // the claim is consumed: the runner refuses it from now on
  const consumed = JSON.parse(r.recordText!).claims
  assert.equal(consumed.length, 1); assert.equal(consumed[0].artifact_sha256, r.artifact_sha256); assert.equal(consumed[0].ended_at, JSON.parse(x.artifactText).ended_at)
  assert.match(checkClaims(consumed, x.inp, FP, codeHashes(), NOW).join(), /is consumed \(its run is recorded\): there is no rerun/)
  // every item of the corpus, each judge: one stored verdict
  const stored = parseStoredVerdicts(r.verdictLog!)
  assert.equal(stored.length, 2 * CORPUS.items.length)
  for (const judge of ['claim_support', 'scan_verification_judge']) for (const split of ['calibration', 'holdout'] as const) {
    assert.equal(stored.filter(v => v.judge === judge && v.split === split).length, CORPUS.items.filter(it => it.split === split).length, `${judge}/${split}`)
  }
  assert.ok(stored.every(v => v.model === MODEL && v.run === 'val-1' && v.origin === 'synthetic'))
  // one calibration entry per judge, from the calibration split, as measured
  const lock = JSON.parse(r.lockText!) as JudgeLock
  assert.deepEqual(lock.judges.map(e => [e.judge.id, e.judge.model, e.ok, e.critical_fp]), [['claim_support', MODEL, true, []], ['scan_verification_judge', MODEL, true, []]])
  assert.ok(lock.judges.every(e => e.source.includes(r.artifact_sha256!) && e.calibrated_at === JSON.parse(x.artifactText).ended_at))
  assert.deepEqual(lock.registered, (JSON.parse(LOCK_TEXT) as JudgeLock).registered, 'the registered fingerprints are untouched')
  // #784: the release gate on the imported lock and log
  const d = releaseGate({ lock, corpus: CORPUS, judges: await releaseInputs(CORPUS), verdicts: r.verdictLog! })
  assert.equal(d.release, 'allowed', d.blocks.join('; '))
  const usable = Object.fromEntries(d.judges.map(j => [j.id, j.real_model.usable]))
  assert.equal(usable.claim_support, true, 'the claim judge is calibrated on this model: its verdicts count')
  assert.equal(usable.scan_verification_judge, false, 'the registered scan judge runs on the tenant\'s own provider: one model\'s calibration does not make it count')
  // before the import neither counted
  const before = releaseGate({ lock: JSON.parse(LOCK_TEXT) as JudgeLock, corpus: CORPUS, judges: await releaseInputs(CORPUS), verdicts: null })
  assert.deepEqual(before.judges.map(j => j.real_model.usable), [false, false])
  // #785: per version and per condition, from the stored answers
  for (const judge of ['claim_support', 'scan_verification_judge']) {
    const h = verdictHistory(stored, { judge })
    assert.ok(h.length > 0 && h.every(v => v.problems.length === 0), judge)
    const text = renderVerdictHistory(h)
    for (const c of ['plain', 'multilingual', 'negation', 'contradiction', 'copied_press', 'date_trap', 'injection']) assert.match(text, new RegExp(c), `${judge}: ${c}`)
    assert.match(text, /claude-sonnet-4-5/)
    assert.ok(detectDrift(stored, { judge }).every(x => x.status !== 'invalid'))
  }
  // importing the same artifact again, now against the consumed record, gives the same files (idempotent)
  const again = await imp({ artifactText: x.artifactText, recordText: r.recordText! })
  assert.deepEqual([again.problems, again.recordText, again.verdictLog], [[], r.recordText, r.verdictLog])
  assert.equal((await imp({ artifactText: x.artifactText, recordText: r.recordText! }, r.lockText!)).lockText, r.lockText, 'and the lock does not grow')
  // a calibration entry added by hand to the lock (another fingerprint, ok: true) does not survive an import
  const planted = JSON.parse(LOCK_TEXT) as JudgeLock
  planted.judges.push({ ...lock.judges[0], fingerprint: planted.registered[0].fingerprint, judge: { ...lock.judges[0].judge, id: planted.registered[0].id, model: 'tenant-provider' } })
  assert.equal((await imp(x, JSON.stringify(planted))).lockText, r.lockText)
  // once consumed, the recorded sha256 is the check: the printed one need not be given again
  assert.deepEqual((await imp({ artifactText: x.artifactText, recordText: r.recordText! }, LOCK_TEXT, null)).problems, [])
})

test('#784 a gullible model (it believes what the page says about itself) completes the run and fails calibration: the entry is recorded as failed with its critical false positives, the gate blocks the release, and nothing counts', async () => {
  const x = await run({ model: 'gullible' })
  const r = await imp(x)
  assert.deepEqual(r.problems, [])
  const lock = JSON.parse(r.lockText!) as JudgeLock
  assert.ok(lock.judges.length === 2 && lock.judges.every(e => e.ok === false && e.problems.length > 0))
  assert.ok(lock.judges.some(e => e.critical_fp.length > 0), 'critical false positives are recorded by item')
  const d = releaseGate({ lock, corpus: CORPUS, judges: await releaseInputs(CORPUS), verdicts: r.verdictLog! })
  assert.equal(d.release, 'blocked')
  assert.match(d.blocks.join('\n'), /critical false positive in its claude-sonnet-4-5 calibration/)
  assert.deepEqual(d.judges.map(j => j.real_model.usable), [false, false], 'a failed calibration never makes a judge count')
})

test('#784 a run that stopped (a failed request) has no results: the claim is consumed, no verdict and no lock entry is written', async () => {
  const x = await run({ failAt: 30 })
  assert.equal(x.requests, 30, 'nothing is sent after the stop')
  const r = await imp(x)
  assert.deepEqual(r.problems, [])
  assert.equal(r.results, false); assert.equal(r.verdictLog, null); assert.deepEqual(r.entries, [])
  assert.deepEqual((JSON.parse(r.lockText!) as JudgeLock).judges, [])
  assert.equal(JSON.parse(r.recordText!).claims[0].artifact_sha256, sha(x.artifactText))
  assert.match(checkClaims(JSON.parse(r.recordText!).claims, x.inp, FP, codeHashes(), NOW).join(), /is consumed/)
})

test('#784 only the claimed run\'s artifact is accepted: another run, another claim, other code, another machine, a second claim, or a different artifact once consumed are all refused with nothing produced', async () => {
  const x = await run(), other = await run({ runId: 'val-2' })
  const refused = (r: Imported, re: RegExp) => { assert.match(r.problems.join('\n'), re); assert.equal(r.recordText, undefined); assert.equal(r.verdictLog, undefined); assert.equal(r.lockText, undefined) }
  refused(await imp({ artifactText: other.artifactText, recordText: x.recordText }), /the artifact is run val-2, the claim is for val-1/)
  const withClaim = (f: (c: Record<string, unknown>) => void) => { const rec = JSON.parse(x.recordText); f(rec.claims[0]); return JSON.stringify(rec) }
  refused(await imp({ artifactText: x.artifactText, recordText: withClaim(c => { c.cap_usd = 2 }) }), /not made under this claim \(claim_sha256 differs\)/)
  refused(await imp({ artifactText: x.artifactText, recordText: withClaim(c => { (c.code_sha256 as Record<string, string>)[CLAIM_CODE_FILES[0]] = 'a'.repeat(64) }) }), /code hash for lib\/evals\/judge\.ts is not the claimed one/)
  refused(await imp({ artifactText: x.artifactText, recordText: withClaim(c => { c.machine_fingerprint = 'b'.repeat(64) }) }), /another machine than the claim names/)
  refused(await imp({ artifactText: x.artifactText, recordText: JSON.stringify({ contract: RUN_RECORD_CONTRACT, note: 't', claims: [x.claim, x.claim] }) }), /exactly one claim \(it holds 2\)/)
  refused(await imp({ artifactText: x.artifactText, recordText: JSON.stringify({ contract: RUN_RECORD_CONTRACT, note: 't', claims: [] }) }), /exactly one claim \(it holds 0\)/)
  refused(await imp({ artifactText: 'not json', recordText: x.recordText }), /the artifact is not JSON/)
  refused(await imp({ artifactText: JSON.stringify({ contract: 'something-else' }), recordText: x.recordText }), /is not a dazl\.judge-validation\/1 result/)
  // once consumed, the recorded sha is the only artifact: an edited copy (one answer flipped) is refused
  const consumed = (await imp(x)).recordText!
  const edited = x.artifactText.replace('"not_supported"', '"supported"') // one "not supported" answer rewritten as a pass
  assert.notEqual(edited, x.artifactText, 'the edit changed the artifact')
  refused(await imp({ artifactText: edited, recordText: consumed }), /already consumed by another artifact \(artifact_sha256 differs\)/)
  // a corpus other than the frozen one
  const r = await importValidationArtifact({ artifactText: x.artifactText, recordText: x.recordText, lockText: LOCK_TEXT, corpus: { ...CORPUS, items: CORPUS.items.slice(1) }, expectSha256: sha(x.artifactText) })
  refused(r, /do not name the same corpus/)
})

test('#784 #785 the committed files agree with each other: with the run\'s artifact committed, the verdict log, the lock entries and the consumed claim are exactly what the artifact gives; without it there is no log, no entry and an unconsumed claim', async () => {
  const record = JSON.parse(read('lib/evals/judge-validation-runs.json')) as { claims: Record<string, unknown>[] }
  const lock = JSON.parse(LOCK_TEXT) as JudgeLock
  const artifact = new URL(ARTIFACT_FIXTURE, WEB), log = new URL(VERDICT_LOG_FIXTURE, WEB)
  if (!existsSync(artifact)) {
    assert.equal(existsSync(log), false, 'no stored-verdict log without the run\'s artifact')
    assert.deepEqual(lock.judges, [], 'no calibration entry without the run\'s artifact')
    for (const c of record.claims) assert.equal(Object.hasOwn(c, 'artifact_sha256') || Object.hasOwn(c, 'ended_at'), false, 'a consumed claim needs its artifact committed beside it')
    return
  }
  const artifactText = readFileSync(artifact, 'utf8')
  const r = await importValidationArtifact({ artifactText, recordText: read('lib/evals/judge-validation-runs.json'), lockText: LOCK_TEXT, corpus: CORPUS })
  assert.deepEqual(r.problems, [])
  assert.equal(record.claims[0].artifact_sha256, sha(artifactText), 'the claim is consumed by this artifact')
  assert.equal(read('lib/evals/judge-validation-runs.json'), r.recordText)
  assert.equal(LOCK_TEXT, r.lockText, 'the lock is the artifact\'s')
  assert.deepEqual(lock.judges, r.entries, 'the lock\'s calibration entries are exactly the artifact\'s: none added by hand')
  if (r.results) assert.equal(readFileSync(log, 'utf8'), r.verdictLog, 'the stored-verdict log is the artifact\'s')
  else assert.equal(existsSync(log), false)
})

test('#784 the committed record holds the one pre-call claim for the approved run: its approval, the staging machine, model, cap and state dir, every runner code file hashed, unconsumed, within its 7 days', () => {
  const record = JSON.parse(read('lib/evals/judge-validation-runs.json')) as { contract: string; claims: Record<string, unknown>[] }
  assert.equal(record.contract, RUN_RECORD_CONTRACT); assert.equal(record.claims.length, 1)
  const c = record.claims[0]
  assert.equal(c.run_id, 'jv-396-20261113'); assert.equal(c.approval, APPROVAL); assert.equal(c.model, MODEL); assert.equal(c.cap_usd, 3)
  assert.equal(c.machine_fingerprint, 'c47e12eefff9cc06540aee767185845087a56318dc86fbe65e90608167659fc4'); assert.equal(c.state_dir, '/var/lib/dazl-judge-validation')
  assert.deepEqual(Object.keys(c.code_sha256 as object), [...CLAIM_CODE_FILES])
  for (const h of Object.values(c.code_sha256 as Record<string, string>)) assert.match(h, /^[0-9a-f]{64}$/)
  assert.ok(Date.parse(String(c.expires_at)) - Date.parse(String(c.created_at)) <= 7 * 86_400_000)
  // the cap in CAD, all-in, is inside the approval
  const fx = c.fx as { cad_per_usd: number }, fee = c.fee as { rate: number }
  assert.ok(3 * fx.cad_per_usd * (1 + fee.rate) <= 5)
})

test('#784 the key: the run\'s own name everywhere; on staging only, and only when that is unset, the key staging holds; both names leave the environment; no other name is read', () => {
  let env: Record<string, string | undefined> = { [STAGING_KEY_ENV]: KEY }
  assert.ok('problem' in readKeyFromEnv(env), 'not staging: the staging name is not read')
  assert.equal(env[STAGING_KEY_ENV], KEY, 'and is left alone')
  env = { DAZL_ENV: 'staging', [STAGING_KEY_ENV]: KEY }
  assert.deepEqual(readKeyFromEnv(env), { key: KEY, name: STAGING_KEY_ENV }); assert.equal(STAGING_KEY_ENV in env, false)
  const own = `sk-ant-own-${'o'.repeat(30)}`
  env = { DAZL_ENV: 'staging', [STAGING_KEY_ENV]: KEY, [KEY_ENV]: own }
  assert.deepEqual(readKeyFromEnv(env), { key: own, name: KEY_ENV }, 'the run\'s own name wins')
  assert.equal(KEY_ENV in env || STAGING_KEY_ENV in env, false, 'both are removed')
  for (const e of [{ DAZL_ENV: 'Staging', [STAGING_KEY_ENV]: KEY }, { DAZL_ENV: 'production', [STAGING_KEY_ENV]: KEY }, { DAZL_ENV: 'staging', ANTHROPIC_API_KEY: KEY }, { DAZL_ENV: 'staging', [STAGING_KEY_ENV]: 'short' }]) assert.ok('problem' in readKeyFromEnv({ ...e }), JSON.stringify(Object.keys(e)))
  // the run's own name set but empty on staging: refused, never a silent switch to the staging key
  env = { DAZL_ENV: 'staging', [KEY_ENV]: '', [STAGING_KEY_ENV]: KEY }
  const empty = readKeyFromEnv(env)
  assert.ok('problem' in empty && /is set but empty/.test(empty.problem) && empty.problem.includes('unset it to use the staging key')); assert.equal(KEY_ENV in env || STAGING_KEY_ENV in env, false)
  const p = readKeyFromEnv({ DAZL_ENV: 'staging' })
  assert.ok('problem' in p && p.problem.includes(KEY_ENV) && p.problem.includes(STAGING_KEY_ENV) && !p.problem.includes(KEY))
})

test('#784 #785 the import command: checks only by default, writes nothing on a refusal, and names what it would write', async () => {
  const x = await run()
  const f = join(tmp(), 'artifact.json'); writeFileSync(f, x.artifactText)
  const cli = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', 'scripts/judge-validation-import.mts', ...args], { cwd: WEB, encoding: 'utf8' })
  // the test run's artifact is not the committed claim's run: refused, exit 2, nothing written
  const before = [read('lib/evals/judge-validation-runs.json'), LOCK_TEXT]
  const r = cli(['--artifact', f, '--expect-sha256', sha(x.artifactText), '--write'])
  assert.equal(r.status, 2); assert.match(r.stderr, /REFUSED \(nothing written\)/); assert.match(r.stderr, /the artifact is run val-1, the claim is for jv-396-20261113/)
  const noSha = cli(['--artifact', f, '--write']); assert.equal(noSha.status, 2); assert.match(noSha.stderr, /give the artifact sha256 the run printed/)
  assert.equal(cli(['--artifact', f, '--expect-sha256', 'not-a-sha']).status, 2)
  assert.deepEqual(readdirSync(new URL('test/fixtures/evals/judges/', WEB)).filter(n => n.endsWith('.import-tmp')), [], 'no temporary file is left behind')
  assert.deepEqual([read('lib/evals/judge-validation-runs.json'), read(LOCK_FIXTURE)], before)
  assert.equal(cli([]).status, 2); assert.equal(cli(['--artifact', join(tmp(), 'missing.json')]).status, 2); assert.equal(cli(['--artifact', f, '--force']).status, 2)
})

test('#784 a report is never taken at its word: an artifact whose failed calibration was edited to ok (problems and critical false positives emptied), or whose answers were edited without its rates, is refused; nothing counts', async () => {
  for (const model of ['english_only', 'flaky', 'gullible'] as const) {
    const x = await run({ model })
    const honest = await imp(x)
    assert.deepEqual(honest.problems, [], model)
    assert.ok(honest.entries!.some(e => !e.ok), `${model}: the run itself fails calibration`)
    const a = JSON.parse(x.artifactText)
    for (const judge of ['claim_support', 'scan_verification_judge']) Object.assign(a.results[judge].calibration.report, { ok: true, problems: [], critical_fp: [] })
    const forged = { artifactText: JSON.stringify(a, null, 1), recordText: x.recordText }
    const r = await imp(forged)
    assert.match(r.problems.join('\n'), /report does not follow from its own recorded answers \(re-scored, these fields differ: [a-z_, ]*\bok\b/, model)
    assert.equal(r.lockText, undefined); assert.equal(r.verdictLog, undefined); assert.equal(r.recordText, undefined)
  }
  // the other direction: the summary untouched, one recorded attempt rewritten from "not supported" to "supported"
  const x = await run()
  const a = JSON.parse(x.artifactText)
  const items = a.results.claim_support.calibration.report.items as Record<string, { answer: string; attempts: { answer: string }[] }>
  const id = Object.keys(items).find(k => items[k].attempts[0].answer === 'not_supported')!
  items[id].attempts[0].answer = 'supported'
  const r = await imp({ artifactText: JSON.stringify(a, null, 1), recordText: x.recordText })
  assert.match(r.problems.join('\n'), /claim_support\/calibration report does not follow from its own recorded answers/)
  // an attempt removed (fewer answers than the plan asks)
  const b = JSON.parse(x.artifactText)
  const first = Object.keys(b.results.scan_verification_judge.holdout.report.items)[0]
  b.results.scan_verification_judge.holdout.report.items[first].attempts.pop()
  assert.match((await imp({ artifactText: JSON.stringify(b, null, 1), recordText: x.recordText })).problems.join('\n'), /scan_verification_judge\/holdout report does not follow from its own recorded answers/)
})

test('#784 only the file the run printed can consume the claim: without the printed sha256, or with another, an otherwise valid artifact is refused', async () => {
  const x = await run()
  assert.match((await imp(x, LOCK_TEXT, null)).problems.join('\n'), /the claim is not consumed yet: give the artifact sha256 the run printed/)
  assert.match((await imp(x, LOCK_TEXT, 'a'.repeat(64))).problems.join('\n'), /this is not the artifact the run printed/)
  // a re-serialised copy of the same result (same content, other bytes) is not the printed file either
  const copy = { artifactText: JSON.stringify(JSON.parse(x.artifactText)), recordText: x.recordText }
  assert.match((await imp(copy, LOCK_TEXT, x.printedSha!)).problems.join('\n'), /this is not the artifact the run printed/)
  assert.deepEqual((await imp(x, LOCK_TEXT, x.printedSha!)).problems, [])
})

test('#784 more refusals: an artifact that does not name one of the two key variables, one scored under other thresholds, a report filed under another split or judge; and a run with no results clears a lock entry planted by hand', async () => {
  const x = await run()
  // the parts of the artifact these cases edit
  type Report = { judge: { id: string } }
  type Editable = { run_guard: { key_env?: string | null }; fixed_before_run: { thresholds: Record<string, number> }; results: Record<string, Record<string, { report: Report }>> }
  const mutate = async (f: (a: Editable) => void) => {
    const a = JSON.parse(x.artifactText); f(a)
    return imp({ artifactText: JSON.stringify(a, null, 1), recordText: x.recordText })
  }
  assert.match((await mutate(a => { a.run_guard.key_env = 'ANTHROPIC_API_KEY' })).problems.join('\n'), /does not say which of the two key names paid/)
  assert.match((await mutate(a => { a.run_guard.key_env = null })).problems.join('\n'), /does not say which of the two key names paid/)
  assert.match((await mutate(a => { delete a.run_guard.key_env })).problems.join('\n'), /does not say which of the two key names paid/)
  assert.match((await mutate(a => { a.fixed_before_run.thresholds.max_fp_rate = 1 })).problems.join('\n'), /not scored with the thresholds, repeats and source reversal fixed in this code/)
  assert.match((await mutate(a => { a.results.claim_support.holdout.report = a.results.claim_support.calibration.report })).problems.join('\n'), /claim_support\/holdout report is not that judge, split, model and corpus/)
  assert.match((await mutate(a => { a.results.scan_verification_judge.calibration.report.judge.id = 'claim_support' })).problems.join('\n'), /scan_verification_judge\/calibration report is not that judge, split, model and corpus/)
  // a stopped run: no results, and the lock it writes holds no calibration entry at all, whatever was there
  const stopped = await run({ failAt: 30 })
  const planted = JSON.parse(LOCK_TEXT) as JudgeLock
  planted.judges.push((JSON.parse((await imp(x)).lockText!) as JudgeLock).judges[0])
  const r = await imp(stopped, JSON.stringify(planted))
  assert.deepEqual(r.problems, []); assert.deepEqual((JSON.parse(r.lockText!) as JudgeLock).judges, [])
})

test('#784 after consumption: while the scoring code is the run\'s, the committed artifact is still re-scored (a claim consumed by hand around a forged report is refused, as CI would see it); once that code has changed, the recorded sha256 alone binds it and a wording change cannot break the paid result', async () => {
  const x = await run({ model: 'english_only' })
  const a = JSON.parse(x.artifactText)
  // forged: the failed calibration edited to ok, and the claim consumed BY HAND with the forged file's sha256
  for (const judge of ['claim_support', 'scan_verification_judge']) Object.assign(a.results[judge].calibration.report, { ok: true, problems: [], critical_fp: [] })
  const forged = JSON.stringify(a, null, 1)
  const byHand = JSON.parse(x.recordText); Object.assign(byHand.claims[0], { artifact_sha256: sha(forged), ended_at: a.ended_at })
  const sameCode = await importValidationArtifact({ artifactText: forged, recordText: JSON.stringify(byHand), lockText: LOCK_TEXT, corpus: CORPUS })
  assert.match(sameCode.problems.join('\n'), /report does not follow from its own recorded answers/, 'CI re-scores the committed artifact: the scoring code is the run\'s')
  // the honest artifact, consumed, after the scoring code changed (another hash for judge.ts): not re-scored, still imports
  const honest = await run()
  const consumed = (await imp(honest)).recordText!
  const h = JSON.parse(honest.artifactText)
  h.results.claim_support.calibration.report.limits = ['worded differently by the version of the scoring code that made the run']
  const older = JSON.stringify(h, null, 1)
  const rec = JSON.parse(consumed); rec.claims[0].artifact_sha256 = sha(older)
  const drifted = { ...codeHashes(), 'lib/evals/judge.ts': 'f'.repeat(64) }
  const later = await importValidationArtifact({ artifactText: older, recordText: JSON.stringify(rec), lockText: LOCK_TEXT, corpus: CORPUS, currentCode: drifted })
  assert.deepEqual(later.problems, [], 'the scoring code changed since the run: bound by the recorded sha256, not re-scored')
  // a scoring file that cannot be read is not "changed code": refused, never a skipped re-score
  const unreadable = await importValidationArtifact({ artifactText: older, recordText: JSON.stringify(rec), lockText: LOCK_TEXT, corpus: CORPUS, currentCode: { ...codeHashes(), 'lib/scan/runner.ts': 'unreadable' } })
  assert.match(unreadable.problems.join('\n'), /this checkout's lib\/scan\/runner\.ts cannot be read/); assert.equal(unreadable.lockText, undefined)
  // the same file while the code is still the run\'s is re-scored and refused; so is the unconsumed case, whatever the code
  assert.match((await importValidationArtifact({ artifactText: older, recordText: JSON.stringify(rec), lockText: LOCK_TEXT, corpus: CORPUS })).problems.join('\n'), /these fields differ: limits/)
  assert.match((await importValidationArtifact({ artifactText: older, recordText: honest.recordText, lockText: LOCK_TEXT, corpus: CORPUS, expectSha256: sha(older), currentCode: drifted })).problems.join('\n'), /these fields differ: limits/)
})
