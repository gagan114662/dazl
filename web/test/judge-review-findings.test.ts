// Hermes's review of PR #1044 at 4416fe5e (#396: #783, #784, #785): one test per finding, each a case the code at
// 4416fe5e got wrong. They use only the API that existed at 4416fe5e, so each one, run against that head's
// lib/evals/judge.ts or scripts/judges.mts, fails on its own. Stub models and temp files only: no key, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  calibrate, checkCorpus, detectDrift, judgeGate, lockEntry, parseStoredVerdicts, releaseGate, toStoredVerdicts, truthLabel, verdictHistory,
  JudgeCorpusError, type JudgeCorpus, type JudgeItem, type JudgeLock, type JudgeSpec, type JudgeTruth, type StoredVerdict,
} from '../lib/evals/judge.ts'
import * as judgeModule from '../lib/evals/judge.ts'
import { CLAIM_SUPPORT_SPEC, claimSupportJudge, releaseInputs, STUB_MODELS } from './helpers/judge-stubs.ts'

// claimText is read off the module object, so this file still loads against an older judge.ts that lacks it (each test
// then fails on its own, which is what the fail-before check needs)
const claimText = (c: JudgeTruth['claim']) => (judgeModule as unknown as { claimText: (c: JudgeTruth['claim']) => string }).claimText(c)
const DIR = new URL('./fixtures/evals/judges/', import.meta.url)
const WEB = fileURLToPath(new URL('..', import.meta.url))
const CORPUS = JSON.parse(readFileSync(new URL('corpus.synthetic.json', DIR), 'utf8')) as JudgeCorpus
const LOCK = JSON.parse(readFileSync(new URL('judges.lock.json', DIR), 'utf8')) as JudgeLock
const V1: JudgeSpec = { id: 'claim_support', version: 1, model: 'sim-model-a', prompt_version: 1 }
const V2: JudgeSpec = { ...V1, model: 'sim-model-b' }
const AT = '2026-11-10T00:00:00Z', SRC = 'test: simulated real-model calibration'
const day = (d: number) => `2026-11-0${d}T00:00:00Z`
const run = async (spec: JudgeSpec, stub: keyof typeof STUB_MODELS, id: string, d: number) =>
  toStoredVerdicts(await calibrate(claimSupportJudge(CORPUS, STUB_MODELS[stub](), spec), CORPUS), CORPUS, id, day(d))
const jsonl = (rs: StoredVerdict[]) => rs.map(r => JSON.stringify(r)).join('\n') + '\n'
const refused = (c: JudgeCorpus, re: RegExp, what: string) =>
  assert.throws(() => checkCorpus(c), (e: unknown) => e instanceof JudgeCorpusError && re.test((e as Error).message), what)
const withItem = (id: string, f: (it: JudgeItem) => void) => { const c = structuredClone(CORPUS); f(c.items.find(i => i.id === id)!); return c }
const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', 'scripts/judges.mts', ...args], {
  cwd: WEB, encoding: 'utf8', env: { ...process.env, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0' }, timeout: 120_000,
})
// cal-plain-pos with its one source reduced to `sentence`, which is also the funding fact's evidence (undated) and its quote
const onlySentence = (sentence: string) => withItem('cal-plain-pos', it => {
  it.sources[0].text = `${sentence}.`; it.truth!.facts[0].evidence = sentence; delete it.truth!.facts[0].date; it.quote = sentence
})
const tmp = () => mkdtempSync(join(tmpdir(), 'dazl-judge-'))

test('finding 1: truth records must be stated by the text they describe - the displayed claim, and each fact\'s evidence', () => {
  checkCorpus(CORPUS) // the committed corpus, multilingual evidence included, states every attribute it records
  // the displayed claim changed under unchanged funding records
  refused(withItem('cal-plain-pos', it => { it.claim = 'Querix closed permanently.' }), /cal-plain-pos: the displayed claim is not the one its truth claim renders \("Querix raised a seed round\."\)/, 'claim text rewritten')
  refused(withItem('cal-date-pos', it => { it.claim = 'Copperline raised a Series A on 9 October 2026.' }), /cal-date-pos: the displayed claim is not the one its truth claim renders/, 'claim date rewritten')
  refused(withItem('hold-ml-contact-neg', it => { it.claim = 'marie@vellichor.fr is the sales lead at Vellichor.' }), /hold-ml-contact-neg: the displayed claim is not the one its truth claim renders/, 'claim contact rewritten')
  // a role fact for a person the evidence never names, on a page that only says an annual report came out
  refused(withItem('cal-plain-pos', it => {
    it.sources[0].text += ' Querix published its annual report.'
    it.claim = 'Jane Doe is the current Head of Sales at Querix.'
    it.quote = 'Querix published its annual report'
    it.truth = { claim: { company: 'Querix', kind: 'role', person: 'Jane Doe', detail: 'Head of Sales' }, facts: [{ source: 1, evidence: 'Querix published its annual report.', company: 'Querix', kind: 'role', status: 'asserted', person: 'Jane Doe', detail: 'Head of Sales' }] }
  }), /cal-plain-pos: fact 1: its evidence does not state its kind, detail, person/, 'role fact the evidence does not state')
  // each attribute of a fact on its own
  refused(withItem('cal-plain-pos', it => { it.truth!.facts[0].date = '2026-11' }), /fact 1: its evidence does not state its date/, 'fact date')
  refused(withItem('cal-plain-pos', it => { it.truth!.facts[0].detail = 'series a' }), /fact 1: its evidence does not state its detail/, 'fact detail')
  refused(withItem('cal-plain-pos', it => { it.truth!.facts[0].kind = 'acquisition' }), /fact 1: its evidence does not state its kind/, 'fact kind')
  refused(withItem('hold-ml-contact-neg', it => { it.truth!.facts[0].evidence = 'a quitté Vellichor en 2025' }), /fact 1: its evidence does not state its kind, person, contact/, 'fact person and contact')
  // the status is bound too: a negated claim, a denial filed as an assertion, a retraction whose words retract nothing
  refused(withItem('cal-plain-pos', it => { it.claim = 'Querix did not raise a seed round.' }), /cal-plain-pos: the displayed claim is not the one its truth claim renders \("Querix raised a seed round\."\)/, 'negated claim')
  refused(withItem('cal-neg-neg', it => { it.label = 'supported'; it.quote = 'denied reports that it raised a seed round'; it.truth!.facts[0].status = 'asserted' }), /fact 1: its evidence does not state its status \(asserted, but the text is negated\)/, 'denial filed as an assertion')
  refused(withItem('cal-plain-pos', it => { it.label = 'not_supported'; delete it.quote; it.truth!.facts[0].status = 'denied' }), /fact 1: its evidence does not state its status \(denied\)/, 'assertion filed as a denial')
  refused(withItem('cal-plain-pos', it => { it.truth!.facts[0].status = 'planned' }), /fact 1: its evidence does not state its status \(planned\)/, 'past event filed as a plan')
})

test('finding 2: a retraction applies only when its date can be the claim\'s date', () => {
  const claim = { company: 'Acme', kind: 'funding' as const, detail: 'seed', date: '2026' }
  const yes = { source: 1, evidence: 'Acme raised a seed round in March 2026', company: 'Acme', kind: 'funding' as const, status: 'asserted' as const, detail: 'seed', date: '2026-03' }
  const no = { ...yes, status: 'denied' as const }
  const L = (facts: JudgeTruth['facts'], c: JudgeTruth['claim'] = claim) => truthLabel({ claim: c, facts })
  assert.equal(L([yes, { ...no, date: '2025' }]), 'supported', 'a denial of a 2025 round does not cancel a 2026 one')
  assert.equal(L([yes, { ...no, date: '2026-07' }], { ...claim, date: '2026-03' }), 'supported', 'a denial about July does not cancel a March claim')
  assert.equal(L([yes, { ...no, date: '2026' }]), 'not_supported', 'a denial of the same year')
  assert.equal(L([yes, { ...no, date: '2026-03-02' }]), 'not_supported', 'a denial inside the claimed year')
  assert.equal(L([yes, { ...no, date: '2026' }], { ...claim, date: '2026-03' }), 'not_supported', 'a year-level denial covers a month claim')
  assert.equal(L([yes, { ...no, date: undefined }]), 'not_supported', 'an undated denial still applies')
})

test('finding 3: --verdicts validates the existing log before appending, and leaves a v1 log exactly as it was', async () => {
  const d = tmp()
  try {
    const log = join(d, 'verdicts.jsonl')
    const [first] = await run(V1, 'truthful', 'old-run', 1)
    const v1 = JSON.stringify(Object.fromEntries(Object.entries({ ...first, v: 1 }).filter(([k]) => k !== 'version' && k !== 'prompt_version'))) + '\n'
    writeFileSync(log, v1)
    for (const attempt of [1, 2]) {
      const r = cli('--verdicts', log)
      assert.equal(r.status, 1, `attempt ${attempt}: ${r.stdout.slice(-400)}`)
      assert.match(r.stdout, /verdict log .* left unchanged: verdict log line 1: a v1 record has no judge version/)
      assert.equal(readFileSync(log, 'utf8'), v1, `attempt ${attempt}: the v1 log is untouched`)
    }
    // a damaged last line is refused the same way, and the file is not touched
    const cut = jsonl(await run(V1, 'truthful', 'r1', 1)).slice(0, -30)
    writeFileSync(log, cut)
    assert.equal(cli('--verdicts', log).status, 1)
    assert.equal(readFileSync(log, 'utf8'), cut)
    // a valid (or absent) log is appended to: one run per call
    rmSync(log)
    for (const n of [1, 2]) {
      const r = cli('--verdicts', log)
      assert.equal(r.status, 0, r.stdout.slice(-400))
      const recs = parseStoredVerdicts(readFileSync(log, 'utf8'))
      assert.equal(new Set(recs.map(x => x.run)).size, n)
      assert.equal(recs.length, n * 2 * CORPUS.items.filter(i => i.split === 'calibration').length)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('finding 4: one (judge, fingerprint) is one judge identity across the whole log', async () => {
  const a = await run(V1, 'truthful', 'r1', 1)
  const relabelled = (await run(V1, 'truthful', 'r2', 2)).map(r => ({ ...r, model: 'OTHER-MODEL', version: 9 }))
  assert.equal(relabelled[0].fingerprint, a[0].fingerprint)
  assert.throws(() => parseStoredVerdicts(jsonl([...a, ...relabelled])), (e: unknown) => e instanceof JudgeCorpusError && /recorded as two judge identities/.test((e as Error).message))
  assert.throws(() => detectDrift([...a, ...relabelled], { judge: 'claim_support' }), /recorded as two judge identities/, 'not "stable"')
  assert.throws(() => verdictHistory([...a, ...relabelled], { judge: 'claim_support' }), /recorded as two judge identities/, 'not merged into one version')
  // the prompt version alone, too
  assert.throws(() => parseStoredVerdicts(jsonl([...a, ...a.map(r => ({ ...r, run: 'r3', at: day(3), prompt_version: 2 }))])), /two judge identities/)
})

test('finding 5: a rollback is a new epoch, and the latest transition is reported in its real direction', async () => {
  const A1 = await run(V1, 'truthful', 'r1', 1), B = await run(V2, 'english_only', 'r2', 2), A2 = await run(V1, 'truthful', 'r3', 3)
  const [h] = verdictHistory(parseStoredVerdicts(jsonl([...A1, ...B, ...A2])), { judge: 'claim_support' })
  const fa = A1[0].fingerprint, fb = B[0].fingerprint
  assert.deepEqual(h.versions.map(v => [v.fingerprint, v.runs]), [[fa, ['r1']], [fb, ['r2']], [fa, ['r3']]])
  assert.deepEqual(h.changes.map(c => [c.from, c.to]), [[fa, fb], [fb, fa]], 'A->B, then the rollback B->A')
  assert.equal(h.changes[0].by_condition.multilingual!.abstain_rate, 1)
  assert.equal(h.changes[1].by_condition.multilingual!.abstain_rate, -1, 'the rollback undoes the abstentions')
  assert.ok(h.changes[1].flipped.includes('cal-ml-pos'))
})

test('finding 6: a truncated run is never compared by intersection: drift is invalid (never stable), and history reports it', async () => {
  const full = await run(V1, 'truthful', 'r1', 1)
  const cut = (await run(V1, 'truthful', 'r2', 2)).filter(r => r.item !== 'cal-date-neg' && r.item !== 'cal-plain-neg')
  assert.ok(full.find(r => r.item === 'cal-date-neg')!.critical, 'a critical item is among the missing')
  const recs = parseStoredVerdicts(jsonl([...full, ...cut]))
  const [d] = detectDrift(recs, { judge: 'claim_support' })
  assert.notEqual(d.status, 'stable')
  assert.notEqual(d.status, 'insufficient')
  assert.ok(d.problems.some(p => /hold different items/.test(p)), d.problems.join('; '))
  const [h] = verdictHistory(recs, { judge: 'claim_support' })
  assert.deepEqual(h.versions, [], 'no rates from runs that hold different items')
  assert.ok((h as unknown as { problems: string[] }).problems.some(p => /hold different items/.test(p)))
  // a padded run (an item the others lack) is refused the same way
  const padded = [...full.map(r => ({ ...r, run: 'r3', at: day(3) })), { ...full[0], run: 'r3', at: day(3), item: 'extra-item' }]
  assert.notEqual(detectDrift([...full, ...padded], { judge: 'claim_support' })[0].status, 'stable')
})

test('finding 7: a lock entry counts only when every field is present, typed, and matches the judge and corpus', async () => {
  const j = claimSupportJudge(CORPUS, STUB_MODELS.truthful(), V1)
  const full = lockEntry(await calibrate(j, CORPUS), AT, SRC) as unknown as Record<string, unknown>
  const usable = (e: unknown) => judgeGate(j, { ...LOCK, judges: [e] } as unknown as JudgeLock, CORPUS).usable
  assert.equal(usable(full), true, 'the complete entry counts')
  const partial = { fingerprint: full.fingerprint, corpus_hash: full.corpus_hash, ok: true, problems: [], critical_fp: [] }
  assert.equal(usable(partial), false, 'Hermes\'s partial entry')
  for (const k of Object.keys(full)) assert.equal(usable(Object.fromEntries(Object.entries(full).filter(([x]) => x !== k))), false, `missing ${k}`)
  const bad: [string, Record<string, unknown>][] = [
    ['empty source', { source: '' }], ['source not text', { source: 7 }], ['time not a time', { calibrated_at: 'yesterday' }], ['impossible day', { calibrated_at: '2026-02-30T00:00:00Z' }],
    ['origin of another corpus', { origin: 'live' }], ['unknown origin', { origin: 'mixed' }],
    ['another model under this fingerprint', { judge: { ...V1, model: 'OTHER-MODEL' } }], ['another version', { judge: { ...V1, version: 2 } }],
    ['partial spec', { judge: { id: V1.id } }], ['spec with an extra field', { judge: { ...V1, temperature: 0 } }], ['stub model', { judge: { ...V1, model: 'stub:truthful' } }],
    ['extra field', { trusted: true }], ['problems not text', { problems: [1] }], ['critical_fp not a list', { critical_fp: 'none' }], ['fingerprint not a sha256', { fingerprint: 'abc' }],
  ]
  for (const [what, patch] of bad) assert.equal(usable({ ...full, ...patch }), false, what)
  // a malformed entry anywhere in the lock blocks release, never allows it
  assert.equal(releaseGate({ lock: { ...LOCK, judges: [partial] } as unknown as JudgeLock, corpus: CORPUS, judges: await releaseInputs(CORPUS), verdicts: null }).release, 'blocked')
})

test('finding 8: the CLI/CI gate loads the stored-verdict log and checks drift; a calibrated judge with no drift evidence blocks', async () => {
  const d = tmp()
  try {
    const cal = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), CLAIM_SUPPORT_SPEC), CORPUS)
    const lockFile = join(d, 'lock.json'), logFile = join(d, 'verdicts.jsonl')
    writeFileSync(lockFile, JSON.stringify({ ...LOCK, judges: [lockEntry(cal, AT, SRC)] }))
    // the committed lock and log (the CI path): releasable, nothing calibrated yet
    const base = cli('--gate')
    assert.equal(base.status, 0, base.stdout.slice(-600))
    // a real calibration and no stored verdicts: drift cannot be checked, so release is blocked
    const none = cli('--gate', '--lock', lockFile, '--verdict-log', join(d, 'absent.jsonl'))
    assert.equal(none.status, 1, none.stdout.slice(-600))
    assert.match(none.stdout, /release gate: BLOCKED/)
    assert.match(none.stdout, /BLOCK: claim_support: the lock holds a calibration of fingerprint [0-9a-f]{64} but the stored-verdict log is missing or unreadable .*drift cannot be checked/)
    // with the calibration's own verdicts stored: allowed, and the judge's verdicts count
    const calRun = toStoredVerdicts(cal, CORPUS, 'cal-run', AT)
    writeFileSync(logFile, jsonl(calRun))
    const ok = cli('--gate', '--lock', lockFile, '--verdict-log', logFile)
    assert.equal(ok.status, 0, ok.stdout.slice(-600))
    assert.match(ok.stdout, /release gate: ALLOWED/)
    assert.match(ok.stdout, /claim_support [0-9a-f]{12}: .*verdicts count: true/)
    // a later run under the same fingerprint that answers differently: drift, read from the log, blocks
    const later = toStoredVerdicts(await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.name_matcher(), CLAIM_SUPPORT_SPEC), CORPUS), CORPUS, 'later-run', '2026-11-11T00:00:00Z')
    writeFileSync(logFile, jsonl([...calRun, ...later]))
    const drifted = cli('--gate', '--lock', lockFile, '--verdict-log', logFile)
    assert.equal(drifted.status, 1)
    assert.match(drifted.stdout, /BLOCK: claim_support: stored verdicts drifted \(synthetic\): .*changed under the same fingerprint/)
    // an unreadable log blocks, and so does a truncated stored run
    writeFileSync(logFile, jsonl(calRun) + '{"v":2')
    const broken = cli('--gate', '--lock', lockFile, '--verdict-log', logFile)
    assert.equal(broken.status, 1)
    assert.match(broken.stdout, /BLOCK: the stored-verdict log is unreadable: verdict log line \d+: not JSON/)
    writeFileSync(logFile, jsonl(calRun.slice(1)))
    assert.equal(cli('--gate', '--lock', lockFile, '--verdict-log', logFile).status, 1, 'a stored run missing a calibration item is not drift evidence')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('finding 9: any supplied drift report that is not exactly a known-status DriftReport blocks release', async () => {
  const judges = await releaseInputs(CORPUS)
  const gate = (drift: unknown[] | undefined) => releaseGate({ lock: LOCK, corpus: CORPUS, judges, verdicts: null, drift: drift as never })
  assert.equal(gate(undefined).release, 'allowed', gate(undefined).blocks.join('\n'))
  const recs = [...await run(V1, 'truthful', 'r1', 1), ...await run(V1, 'truthful', 'r2', 2)]
  const [real] = detectDrift(recs, { judge: 'claim_support' })
  assert.equal(real.status, 'stable')
  assert.equal(gate([real]).release, 'allowed', 'a real stable report is fine')
  const bad: [string, unknown][] = [
    ['Hermes\'s probe', { judge: 'claim_support', status: 'corrupt' }],
    ['unknown status, otherwise well formed', { ...real, status: 'corrupt' }],
    ['status missing', Object.fromEntries(Object.entries(real).filter(([k]) => k !== 'status'))],
    ['problems not a list', { ...real, problems: 'none' }],
    ['extra field', { ...real, ok: true }],
    ['another judge, unknown status', { ...real, judge: 'scan_verification_judge', status: 'fine' }],
    ['latest not a run head', { ...real, latest: 'r2' }],
    ['null', null],
  ]
  for (const [what, d] of bad) {
    const r = gate([real, d])
    assert.equal(r.release, 'blocked', what)
    assert.ok(r.blocks.some(b => /drift report 2 is unreadable/.test(b)), `${what}: ${r.blocks.join('; ')}`)
  }
  assert.equal(releaseGate({ lock: LOCK, corpus: CORPUS, judges, verdicts: null, drift: 'stable' as never }).release, 'blocked', 'drift reports that are not a list')
  // judgeGate refuses the same shapes
  const j = claimSupportJudge(CORPUS, STUB_MODELS.truthful(), V1)
  const lock = { ...LOCK, judges: [lockEntry(await calibrate(j, CORPUS), AT, SRC)] }
  assert.equal(judgeGate(j, lock, CORPUS, [real]).usable, true)
  for (const [what, d] of bad) assert.equal(judgeGate(j, lock, CORPUS, [real, d] as never).usable, false, what)
})

// --- the independent review at 1f045566 (R1-R4, R6, R7): each fails at 1f045566 -------------------------------------

test('R1: the displayed claim is rendered from the truth claim, and asserted evidence cannot be a failure, modal, rumour or another sense of the kind word', () => {
  for (const claim of ['Querix closed permanently after its seed round collapsed.', 'Querix failed to raise a seed round.', 'Querix may raise a seed round.', 'Northwind, unlike Querix, raised a seed round.', 'Querix is rumoured to have raised a seed round, which it refuted.', 'Querix raised a seed round!']) {
    refused(withItem('cal-plain-pos', it => { it.claim = claim }), /cal-plain-pos: the displayed claim is not the one its truth claim renders \("Querix raised a seed round\."\)/, claim)
  }
  const asserted = (sentence: string, why: string, re: RegExp) => refused(withItem('cal-plain-pos', it => {
    it.sources[0].text += ` ${sentence}.`; it.truth!.facts[0].evidence = sentence; delete it.truth!.facts[0].date
  }), re, why)
  asserted('Querix failed to raise a seed round in October 2026', 'failure filed as an assertion', /fact 1: its evidence does not state its status \(asserted, but the text is a failure, modal, rumour or plan\)/)
  asserted('Querix may raise a seed round', 'modal filed as an assertion', /status \(asserted, but the text is a failure, modal, rumour or plan\)/)
  asserted('Querix is rumoured to have raised a seed round', 'rumour filed as an assertion', /status \(asserted, but the text is a failure, modal, rumour or plan\)/)
  asserted('Querix announced a seed round of layoffs', 'layoffs filed as funding', /fact 1: its evidence does not state its kind \(a kind word used in another sense\)/)
  // every committed claim is exactly its rendering: a reworded one is refused
  for (const it of CORPUS.items) refused(withItem(it.id, x => { x.claim = x.claim.replace(/\.$/, ', sources say.') }), new RegExp(`${it.id}: the displayed claim is not the one its truth claim renders`), it.id)
})

test('R2: a fact\'s company is the subject of its evidence sentence; "no relation to <other>" is allowed, a swapped company is not', () => {
  const corvid = CORPUS.items.find(i => i.id === 'hold-plain-identity-neg')!.truth!.facts[0]
  assert.equal(corvid.evidence, 'Corvid Robotic Systems, no relation to Corvid Robotics, opened a Leeds office', 'the original evidence is restored and accepted')
  refused(withItem('hold-plain-identity-neg', it => {
    it.truth!.facts = [{ ...it.truth!.facts[0], company: 'Corvid Robotics' }]
    it.label = 'supported'; it.quote = 'opened a Leeds office'; it.critical = null
  }), /hold-plain-identity-neg: fact 1: the sentence of its evidence does not name its company Corvid Robotics/, 'identity trap relabelled')
  refused(withItem('hold-copy-neg', it => {
    it.truth!.facts = [{ ...it.truth!.facts[0], company: 'Halden Systems' }]
    it.label = 'supported'; it.quote = 'Holden Systems was acquired by Ferro Group'; it.critical = null
  }), /hold-copy-neg: fact 1: the sentence of its evidence does not name its company Halden Systems/, 'look-alike relabelled')
  refused(withItem('cal-plain-pos', it => { it.truth!.facts[0].company = 'Querix Holdings'; it.sources[0].text += ' Querix Holdings is its parent.' }), /fact 1: the sentence of its evidence does not name its company Querix Holdings/, 'company named elsewhere on the page')
})

test('R3: the gate holds stored runs of a calibrated fingerprint to the lock: a critical false positive in any of them blocks', async () => {
  const cal = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), CLAIM_SUPPORT_SPEC), CORPUS)
  const bad = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.name_matcher(), CLAIM_SUPPORT_SPEC), CORPUS)
  assert.ok(bad.critical_fp.length > 0)
  const lock = { ...LOCK, judges: [lockEntry(cal, AT, SRC)] }
  const judges = await releaseInputs(CORPUS)
  const gate = (rs: StoredVerdict[]) => releaseGate({ lock, corpus: CORPUS, judges, verdicts: jsonl(rs) })
  for (const [what, rs] of [
    ['only a bad run', toStoredVerdicts(bad, CORPUS, 'b1', AT)],
    ['two identical bad runs', [...toStoredVerdicts(bad, CORPUS, 'b1', AT), ...toStoredVerdicts(bad, CORPUS, 'b2', '2026-11-11T00:00:00Z')]],
  ] as const) {
    const d = gate([...rs])
    assert.equal(d.release, 'blocked', what)
    assert.ok(d.blocks.some(b => /^claim_support: a stored run of its calibrated fingerprint has a critical false positive: .*cal-date-neg \(run b1, calibration\)/.test(b)), `${what}: ${d.blocks.join('; ')}`)
    assert.equal(d.judges.find(j => j.id === 'claim_support')!.real_model.usable, false, what)
  }
  assert.equal(gate(toStoredVerdicts(cal, CORPUS, 'c1', AT)).release, 'allowed', 'the calibration\'s own run releases')
})

test('R4: --verdicts leaves the file byte-identical when the combined log\'s drift is invalid (a truncated earlier run)', () => {
  const d = tmp()
  try {
    const log = join(d, 'verdicts.jsonl')
    assert.equal(cli('--verdicts', log).status, 0)
    const full = parseStoredVerdicts(readFileSync(log, 'utf8'))
    const truncated = jsonl(full.filter(r => !(r.judge === 'claim_support' && r.item === 'cal-date-neg')))
    writeFileSync(log, truncated)
    for (const attempt of [1, 2]) {
      const r = cli('--verdicts', log)
      assert.equal(r.status, 1, `attempt ${attempt}`)
      assert.match(r.stdout, /verdict log .* left unchanged: claim_support \(synthetic, calibration\): runs on this corpus version and split hold different items/)
      assert.equal(readFileSync(log, 'utf8'), truncated, `attempt ${attempt}: byte-identical`)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('R6: when the stored-verdict log is unreadable, no judge reads as usable', async () => {
  const cal = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), CLAIM_SUPPORT_SPEC), CORPUS)
  const lock = { ...LOCK, judges: [lockEntry(cal, AT, SRC)] }
  const judges = await releaseInputs(CORPUS)
  for (const verdicts of [jsonl(toStoredVerdicts(cal, CORPUS, 'c1', AT)) + '{"v":2', undefined]) {
    const d = releaseGate({ lock, corpus: CORPUS, judges, verdicts: verdicts as string })
    assert.equal(d.release, 'blocked')
    const rm = d.judges.find(j => j.id === 'claim_support')!.real_model
    assert.equal(rm.usable, false, String(verdicts).slice(-10))
    assert.match(rm.reason, /stored-verdict log/)
  }
})

test('R7: hold-contact-neg keeps its claim detail "sales lead", and its displayed claim says so', () => {
  const it = CORPUS.items.find(i => i.id === 'hold-contact-neg')!
  assert.equal(it.truth!.claim.detail, 'sales lead')
  assert.equal(it.claim, 'Jane Doe (jane@ostro.example) is the current sales lead at Ostro Analytics.')
  assert.equal(it.label, 'not_supported')
})

// --- the re-review at c3bb8855 (R8-R11): each fails at c3bb8855 ------------------------------------------------------

test('R8: a set-apart clause must be punctuation-bounded with a company-name body; a negation cannot hide in it', () => {
  const asserted = (sentence: string) => withItem('cal-plain-pos', it => { it.sources[0].text = `${sentence}.`; it.truth!.facts[0].evidence = sentence; it.quote = sentence })
  for (const ev of ['Querix unlike what was reported did not raise a seed round in October 2026', 'Querix, unlike the press claimed it never raised a seed round in October 2026', 'Querix, no relation to Not Querix, did not raise a seed round in October 2026']) {
    refused(asserted(ev), /cal-plain-pos: fact 1: its evidence does not state its status \(asserted, but the text is negated\)/, ev)
  }
  // a real set-apart clause still reads as an assertion about its subject (the committed Corvid and Kesselwerke items)
  checkCorpus(CORPUS)
  checkCorpus(asserted('Querix, no relation to Querix Capital, raised a seed round in October 2026'))
})

test('R9: a company is named only as a whole name: "Querix Labs" does not name Querix', () => {
  refused(withItem('cal-plain-pos', it => { it.sources[0].text = it.sources[0].text.replace('Querix,', 'Querix Labs,') }), /cal-plain-pos: fact 1: the sentence of its evidence does not name its company Querix/, 'Querix Labs')
  refused(withItem('cal-plain-pos', it => { it.sources[0].text = it.sources[0].text.replace('Querix,', 'Querixa,') }), /does not name its company Querix/, 'Querixa')
  // R13 (round 3): a capitalised word before the name, a hyphen compound, and a dotted capital I that changes the length
  // of a lower-cased string (no fallback to a looser match)
  for (const sentence of ['Acme Querix raised a seed round', 'Querix-backed Norland raised a seed round', 'Querix Labs raised a seed round in İzmir']) {
    refused(onlySentence(sentence), /cal-plain-pos: fact 1: the sentence of its evidence does not name its company Querix/, sentence)
  }
  // still named: any case, a sentence-initial article, and plain punctuation around the name
  for (const sentence of ['QUERIX raised a seed round', 'The Querix team raised a seed round', 'Querix, a London startup, raised a seed round']) checkCorpus(onlySentence(sentence))
})

test('R14: a possessive or attributive use of the name is not the subject', () => {
  for (const sentence of ["Querix's spin-off Norland raised a seed round", 'Former Querix staff founded Norland, which raised a seed round']) {
    refused(onlySentence(sentence), /cal-plain-pos: fact 1: the sentence of its evidence does not name its company Querix/, sentence)
  }
})

test('R10: the rendered claim says what the label means: an acquirer is named, and a "current" role needs an undated assertion', () => {
  assert.equal(claimText({ company: 'Halden Systems', kind: 'acquisition', detail: 'Ferro Group' }), 'Halden Systems was acquired by Ferro Group.')
  assert.equal(claimText({ company: 'Halden Systems', kind: 'acquisition' }), 'Halden Systems was acquired.')
  const role = { company: 'Quarry Labs', kind: 'role' as const, detail: 'Head of Marketing', person: 'Priya Raman' }
  const fact = { source: 1, evidence: 'Priya Raman, Head of Marketing, Quarry Labs', company: 'Quarry Labs', kind: 'role' as const, status: 'asserted' as const, detail: 'head of marketing', person: 'Priya Raman' }
  assert.equal(claimText(role), 'Priya Raman is the current Head of Marketing at Quarry Labs.')
  assert.equal(truthLabel({ claim: role, facts: [{ ...fact, date: '2024' }] }), 'not_supported', 'a 2024 archive does not say she is the current one')
  assert.equal(truthLabel({ claim: role, facts: [fact] }), 'supported', 'an undated statement does')
  assert.equal(truthLabel({ claim: { ...role, date: '2024' }, facts: [{ ...fact, date: '2024' }] }), 'supported', 'a dated role claim is settled by a fact of that date')
})

test('R11: the gate takes label and criticality from the corpus: a log line that rewrites them blocks', async () => {
  const cal = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), CLAIM_SUPPORT_SPEC), CORPUS)
  const bad = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.name_matcher(), CLAIM_SUPPORT_SPEC), CORPUS)
  const lock = { ...LOCK, judges: [lockEntry(cal, AT, SRC)] }
  const judges = await releaseInputs(CORPUS)
  for (const [what, rs] of [
    ['critical stripped', toStoredVerdicts(bad, CORPUS, 'b1', AT).map(r => ({ ...r, critical: null }))],
    ['critical stripped and label flipped', toStoredVerdicts(bad, CORPUS, 'b1', AT).map(r => r.critical ? { ...r, critical: null, label: 'supported' as const } : r)],
    ['an item the corpus lacks', [...toStoredVerdicts(cal, CORPUS, 'c1', AT), { ...toStoredVerdicts(cal, CORPUS, 'c1', AT)[0], run: 'c2', item: 'ghost-item' }]],
  ] as const) {
    const d = releaseGate({ lock, corpus: CORPUS, judges, verdicts: jsonl([...rs]) })
    assert.equal(d.release, 'blocked', what)
    assert.ok(d.blocks.some(b => /^the stored-verdict log disagrees with corpus judge-claims-synthetic-5/.test(b)), `${what}: ${d.blocks.join('; ')}`)
    assert.equal(d.judges.find(j => j.id === 'claim_support')!.real_model.usable, false, what)
  }
  // with criticality taken from the corpus, the stripped bad run is still a critical false positive of the calibrated fingerprint
  const d = releaseGate({ lock, corpus: CORPUS, judges, verdicts: jsonl(toStoredVerdicts(bad, CORPUS, 'b1', AT).map(r => ({ ...r, critical: null }))) })
  assert.ok(d.blocks.some(b => /a stored run of its calibrated fingerprint has a critical false positive: .*cal-date-neg/.test(b)), d.blocks.join('; '))
})

// --- Hermes at 11927aaf: who did it --------------------------------------------------------------------------------

test('Hermes 11927aaf: another company as the actor, or the fact\'s company only as the reporter, is refused', () => {
  const asserted = (sentence: string) => withItem('cal-plain-pos', it => { it.sources[0].text = `${sentence}.`; it.truth!.facts[0].evidence = sentence; it.quote = 'raised a seed round' })
  const cases: [string, RegExp][] = [
    ['Nordwind raised a seed round in October 2026, says Querix', /cal-plain-pos: fact 1: its company Querix is only the reporter of the sentence/],
    ['According to Querix, Nordwind raised a seed round in October 2026', /cal-plain-pos: fact 1: its company Querix is only the reporter of the sentence/],
    ['Nordwind, a Querix customer, raised a seed round in October 2026', /cal-plain-pos: fact 1: the evidence sentence names Nordwind, not Querix, as the one who did it/],
    ['Querix said Nordwind raised a seed round in October 2026', /cal-plain-pos: fact 1: its company Querix is only the reporter of the sentence \("Querix said <another name> \.\.\."\)/],
  ]
  for (const [sentence, re] of cases) refused(asserted(sentence), re, sentence)
  // the actor rule on its own, with no reporter wording
  refused(asserted('Querix news: Nordwind raised a seed round in October 2026'), /the evidence sentence names Nordwind, not Querix, as the one who did it/, 'Nordwind after a colon')
  // still accepted: the company as actor after a fronted date, through an appositive, or reporting its own round
  for (const sentence of ['In October 2026, Querix raised a seed round', 'Querix, a London startup, raised a seed round in October 2026', 'Querix said it raised a seed round in October 2026']) checkCorpus(asserted(sentence))
  checkCorpus(CORPUS) // all 57 non-exempt committed facts still pass
})

test('documented limit (docs/design/agent-evals.md "Limits"): an actor that does not start a clause still passes checkCorpus', () => {
  // Today's behaviour, pinned so the doc and the code cannot drift apart silently: Nordwind raised the round, but the
  // word-position checks accept it as Querix's. Corpus review is what catches this. If a later change refuses it,
  // update this test and the Limits bullet together.
  const it = withItem('cal-plain-pos', x => { const s = 'Querix announced that Nordwind raised a seed round in October 2026'; x.sources[0].text = `${s}.`; x.truth!.facts[0].evidence = s; x.quote = 'raised a seed round' })
  assert.doesNotThrow(() => checkCorpus(it))
})
