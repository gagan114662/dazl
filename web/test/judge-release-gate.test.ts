// The judge release gate (#784, part of #396), run on every CI run. It recomputes the fingerprint of every judge the code
// runs, runs the calibration harness on that exact fingerprint (each judge's real prompt and parser with stub models
// behind it), and blocks release when a judge changed (model, version or prompt) without a reviewed re-registration,
// when the harness loses its teeth, when a recorded calibration of the current fingerprint has a critical false positive
// (wrong identity, contact or date, or an obeyed injection), or when the corpus is not the frozen one. A judge with no
// real-model calibration does not block release, but its verdicts never count. Stub models only: no key, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  calibrate, detectDrift, judgeFingerprint, judgeGate, lockEntry, releaseGate, toStoredVerdicts, JudgeCorpusError,
  type JudgeAdapter, type JudgeCorpus, type JudgeLock, type ReleaseJudgeInput,
} from '../lib/evals/judge.ts'
import { CLAIM_SUPPORT_SPEC, claimSupportJudge, harnessFor, readVerdictLog, RELEASE_JUDGES, releaseInputs, scanVerificationJudge, STUB_MODELS, VERDICT_LOG, type JudgeBuild } from './helpers/judge-stubs.ts'

const DIR = new URL('./fixtures/evals/judges/', import.meta.url)
const CORPUS = JSON.parse(readFileSync(new URL('corpus.synthetic.json', DIR), 'utf8')) as JudgeCorpus
const LOCK = JSON.parse(readFileSync(new URL('judges.lock.json', DIR), 'utf8')) as JudgeLock
const AT = '2026-11-10T00:00:00Z', SRC = 'test: simulated real-model calibration'
const INPUTS = await releaseInputs(CORPUS)
// The CI path: the committed lock and the committed stored-verdict log, read exactly as scripts/judges.mts --gate reads them.
const COMMITTED_VERDICTS = readVerdictLog(VERDICT_LOG)
const gate = (judges: ReleaseJudgeInput[] = INPUTS, lock: JudgeLock = LOCK, corpus: JudgeCorpus = CORPUS, drift = undefined as Parameters<typeof releaseGate>[0]['drift'], verdicts: string | null = COMMITTED_VERDICTS) => releaseGate({ lock, corpus, judges, verdicts, drift })
const swap = (id: string, input: ReleaseJudgeInput) => INPUTS.map(j => j.spec.id === id ? input : j)
const claimInput = (build: JudgeBuild = claimSupportJudge, spec = CLAIM_SUPPORT_SPEC) => harnessFor(CORPUS, spec, build)
// a "real" calibration of the claim judge's current fingerprint, simulated with a stub behind the judge's real spec
const realRun = (stub: keyof typeof STUB_MODELS) => calibrate(claimSupportJudge(CORPUS, STUB_MODELS[stub](), CLAIM_SUPPORT_SPEC), CORPUS)

test('CI gate: the committed code, lock and corpus are releasable; every registered judge was checked on its exact fingerprint; uncalibrated verdicts do not count', () => {
  const d = gate()
  assert.equal(d.release, 'allowed', d.blocks.join('\n'))
  assert.deepEqual(d.corpus, { id: CORPUS.id, hash: LOCK.corpus.hash, frozen: true })
  assert.deepEqual(d.judges.map(j => j.id).sort(), LOCK.registered.map(r => r.id).sort())
  for (const j of d.judges) {
    assert.equal(j.changed, false); assert.equal(j.fingerprint, j.registered_fingerprint)
    assert.deepEqual(j.harness.map(h => [h.stub, h.ok]), Object.keys(STUB_MODELS).map(s => [s, s === 'truthful']), `${j.id}: only the truthful stub passes`)
    assert.equal(j.real_model.usable, false, `${j.id} has no real-model calibration`)
  }
  assert.ok(d.limits.some(l => /scan_verification_judge: verdicts do not count .* never pass/.test(l)))
  assert.ok(d.limits.some(l => /not ground truth/.test(l)) && d.limits.some(l => /not that any real model is accurate/.test(l)))
})

test('a prompt, model or version change runs the calibration gate on the new fingerprint and blocks release until it is registered', async () => {
  const scan = RELEASE_JUDGES.scan_verification_judge
  const edited: JudgeBuild = (c, m, s) => ({ ...scanVerificationJudge(c, m, s), template: scanVerificationJudge(c, m, s).template + '\nBe generous.' })
  const changes: [string, ReleaseJudgeInput][] = [
    ['scan prompt', await harnessFor(CORPUS, scan.spec, edited)],
    ['claim model', await claimInput(claimSupportJudge, { ...CLAIM_SUPPORT_SPEC, model: 'claude-opus-9' })],
    ['claim version', await claimInput(claimSupportJudge, { ...CLAIM_SUPPORT_SPEC, version: 2 })],
    ['claim prompt version', await claimInput(claimSupportJudge, { ...CLAIM_SUPPORT_SPEC, prompt_version: 2 })],
  ]
  for (const [what, input] of changes) {
    const fp = judgeFingerprint(input.spec, input.template)
    const d = gate(swap(input.spec.id, input))
    assert.equal(d.release, 'blocked', what)
    const j = d.judges.find(x => x.id === input.spec.id)!
    assert.equal(j.changed, true); assert.equal(j.fingerprint, fp)
    assert.ok(input.harness.every(h => h.report.fingerprint === fp), `${what}: the harness ran on the new fingerprint`)
    assert.ok(d.blocks.some(b => b.startsWith(`${input.spec.id} changed (model, version or prompt): fingerprint ${fp} is not registered`)), d.blocks.join('\n'))
    // a reviewed re-registration of the new fingerprint releases it; its verdicts still do not count without a real calibration
    const lock: JudgeLock = { ...LOCK, registered: LOCK.registered.map(r => r.id === input.spec.id ? { ...r, fingerprint: fp } : r) }
    const after = gate(swap(input.spec.id, input), lock)
    assert.equal(after.release, 'allowed', `${what}: ${after.blocks.join('; ')}`)
    assert.equal(after.judges.find(x => x.id === input.spec.id)!.real_model.usable, false)
  }
})

test('critical wrong-identity, wrong-contact, wrong-date and obeyed-injection false positives in a calibration of the current fingerprint block release, by kind', async () => {
  const blind = lockEntry(await realRun('name_matcher'), AT, SRC)
  const d = gate(INPUTS, { ...LOCK, judges: [blind] })
  assert.equal(d.release, 'blocked')
  const j = d.judges.find(x => x.id === 'claim_support')!
  assert.ok(j.critical_fp_by_kind.identity.includes('cal-copy-neg') && j.critical_fp_by_kind.identity.includes('cal-ml-identity-neg'), JSON.stringify(j.critical_fp_by_kind))
  assert.ok(j.critical_fp_by_kind.contact.includes('cal-contact-former-neg'))
  assert.ok(j.critical_fp_by_kind.date.includes('cal-date-neg') && j.critical_fp_by_kind.date.includes('cal-date-pub-neg'))
  assert.ok(d.blocks.some(b => /^claim_support: critical false positive in its claude-sonnet-4-5 calibration \(identity: .*contact: .*date: .*\): release blocked$/.test(b)), d.blocks.join('\n'))
  assert.match(judgeGate(INPUTS[1], { ...LOCK, judges: [blind] }, CORPUS).reason, /failed calibration: critical false positive/)
  const obeys = gate(INPUTS, { ...LOCK, judges: [lockEntry(await realRun('gullible'), AT, SRC)] })
  assert.deepEqual(obeys.judges.find(x => x.id === 'claim_support')!.critical_fp_by_kind.injection, ['cal-inj-neg', 'cal-inj-rubric-neg'])
  assert.equal(obeys.release, 'blocked')
  // a calibration that fails on rates alone (abstains on every non-English page) blocks too
  const lazy = gate(INPUTS, { ...LOCK, judges: [lockEntry(await realRun('english_only'), AT, SRC)] })
  assert.ok(lazy.blocks.some(b => /^claim_support: its claude-sonnet-4-5 calibration failed: multilingual: abstention rate 1\.00 > 0\.5/.test(b)), lazy.blocks.join('\n'))
  // a clean calibration, with its verdicts in the stored-verdict log, releases, and only then do the judge's verdicts count
  const clean = await realRun('truthful')
  const good = gate(INPUTS, { ...LOCK, judges: [lockEntry(clean, AT, SRC)] }, CORPUS, undefined, toStoredVerdicts(clean, CORPUS, 'run-1', AT).map(r => JSON.stringify(r)).join('\n') + '\n')
  assert.equal(good.release, 'allowed', good.blocks.join('\n'))
  assert.deepEqual(good.judges.find(x => x.id === 'claim_support')!.real_model, { usable: true, reason: 'calibrated' })
})

test('the gate fails when the harness loses its teeth: an adversarial stub passing, or the truthful stub failing', async () => {
  // a judge whose parser stopped reading the model (here: always answers like the truthful stub) lets every adversarial stub pass
  const ignoresModel: JudgeBuild = (c, _m, s) => claimSupportJudge(c, STUB_MODELS.truthful(), s)
  const d = gate(swap('claim_support', await claimInput(ignoresModel)))
  assert.equal(d.release, 'blocked')
  for (const stub of ['gullible', 'name_matcher', 'english_only', 'flaky']) assert.ok(d.blocks.some(b => b.startsWith(`claim_support: harness lost its teeth: stub ${stub} passed but must fail`)), stub)
  // a judge that abstains on everything fails the truthful stub
  const silent: JudgeBuild = (c, m, s) => ({ ...claimSupportJudge(c, m, s), ask: async () => ({ answer: 'unknown', quote: null, source: null, reason: 'judge_unknown' }) } as JudgeAdapter)
  const s = gate(swap('claim_support', await claimInput(silent)))
  assert.ok(s.blocks.some(b => b.startsWith('claim_support: harness lost its teeth: stub truthful failed')), s.blocks.join('\n'))
})

test('incomplete or mismatched harness evidence blocks: no adversarial stub, a report of another fingerprint, corpus or split', async () => {
  const claim = INPUTS.find(j => j.spec.id === 'claim_support')!
  assert.ok(gate(swap('claim_support', { ...claim, harness: claim.harness.filter(h => h.stub === 'truthful') })).blocks.some(b => /needs a truthful stub that must pass and at least one adversarial stub/.test(b)))
  assert.ok(gate(swap('claim_support', { ...claim, harness: [] })).blocks.some(b => /needs a truthful stub/.test(b)))
  const other = INPUTS.find(j => j.spec.id === 'scan_verification_judge')!.harness[0]
  assert.ok(gate(swap('claim_support', { ...claim, harness: [other, ...claim.harness.slice(1)] })).blocks.some(b => /harness report for stub truthful is not a calibration-split run of this fingerprint/.test(b)))
  const hold = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), CLAIM_SUPPORT_SPEC), CORPUS, { split: 'holdout' })
  assert.ok(gate(swap('claim_support', { ...claim, harness: [{ stub: 'truthful', expect_pass: true, report: hold }, ...claim.harness.slice(1)] })).blocks.some(b => /not a calibration-split run/.test(b)))
  // the truthful stub must also have no critical false positive (a report edited to pass with one is still blocked)
  const t = claim.harness[0]
  assert.ok(gate(swap('claim_support', { ...claim, harness: [{ ...t, report: { ...t.report, critical_fp: ['cal-date-neg'] } }, ...claim.harness.slice(1)] })).blocks.some(b => /critical false positive under the truthful stub: cal-date-neg/.test(b)))
})

test('an unregistered judge, or a registered judge left unchecked, blocks release', async () => {
  const extra = await harnessFor(CORPUS, { id: 'buyer_need_judge', version: 1, model: 'claude-sonnet-4-5', prompt_version: 1 }, claimSupportJudge)
  assert.ok(gate([...INPUTS, extra]).blocks.some(b => b.startsWith('buyer_need_judge ships unregistered')))
  assert.ok(gate(INPUTS.filter(j => j.spec.id !== 'scan_verification_judge')).blocks.includes('registered judge scan_verification_judge was not checked'))
  assert.ok(gate([]).blocks.includes('no judge was checked'))
})

test('an edited or unfrozen corpus blocks release, and so does drift in stored verdicts', async () => {
  const edited = structuredClone(CORPUS); edited.items[0].why += ' (edited)'
  assert.ok(gate(INPUTS, LOCK, edited).blocks.includes(`corpus ${CORPUS.id} was edited in place: give it a new id and re-freeze it in the lock`))
  const noFreeze = Object.fromEntries(Object.entries(LOCK).filter(([k]) => k !== 'corpus'))
  assert.ok(gate(INPUTS, noFreeze as JudgeLock).blocks.some(b => /pins no frozen corpus/.test(b)))
  const recs = [...toStoredVerdicts(await realRun('truthful'), CORPUS, 'run-1', '2026-11-01T00:00:00Z'), ...toStoredVerdicts(await realRun('name_matcher'), CORPUS, 'run-2', '2026-11-02T00:00:00Z')]
  const d = gate(INPUTS, LOCK, CORPUS, detectDrift(recs, { judge: 'claim_support' }))
  assert.ok(d.blocks.some(b => /^claim_support: stored verdicts drifted \(synthetic\): .*changed under the same fingerprint/.test(b)), d.blocks.join('\n'))
})

test('malformed gate input blocks, never throws and never allows', () => {
  for (const bad of [{ lock: null }, { lock: {} }, { lock: { ...LOCK, judges: null } }, { lock: { ...LOCK, registered: [null] } }]) {
    const d = releaseGate({ lock: bad.lock as never, corpus: CORPUS, judges: INPUTS, verdicts: null })
    assert.equal(d.release, 'blocked', JSON.stringify(bad))
    assert.ok(d.judges.every(j => j.real_model.usable === false))
  }
  for (const judges of [null, 'claim_support', [null], [{ spec: null, template: 't', harness: [] }], [{ ...INPUTS[0], harness: null }], [{ ...INPUTS[0], harness: [null, undefined] }]]) {
    assert.equal(releaseGate({ lock: LOCK, corpus: CORPUS, judges: judges as never, verdicts: null }).release, 'blocked', JSON.stringify(judges)?.slice(0, 60))
  }
  assert.equal(releaseGate({ lock: LOCK, corpus: null as never, judges: INPUTS, verdicts: null }).release, 'blocked')
  assert.equal(releaseGate({ lock: LOCK, corpus: CORPUS, judges: INPUTS, verdicts: null, drift: [null] as never }).release, 'blocked', 'an unreadable drift report is not a clean one')
  // a lock entry whose critical item is not in the corpus still blocks (it is not silently dropped)
  const ghost = { ...LOCK, judges: [{ fingerprint: INPUTS[1].harness[0].report.fingerprint, judge: CLAIM_SUPPORT_SPEC, corpus_hash: LOCK.corpus.hash, origin: 'synthetic' as const, ok: false, problems: ['x'], critical_fp: ['no-such-item'], source: SRC, calibrated_at: AT }] }
  assert.ok(gate(INPUTS, ghost).blocks.some(b => /critical false positive recorded on no-such-item/.test(b)))
})

test('a harness report can never be locked as a calibration', () => {
  const h = INPUTS[0].harness[0]
  assert.equal(h.report.harness_stub, 'truthful')
  assert.throws(() => lockEntry(h.report, AT, SRC), (e: unknown) => e instanceof JudgeCorpusError && /stub-model harness report is not a calibration/.test((e as Error).message))
  assert.throws(() => lockEntry({ ...h.report, harness_stub: undefined, judge: { ...h.report.judge, model: 'stub:truthful' } }, AT, SRC), JudgeCorpusError)
  assert.throws(() => lockEntry({ ...h.report, harness_stub: undefined }, AT, ''), /needs its source/)
})
