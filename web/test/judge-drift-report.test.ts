// Per-condition false-positive / false-negative / abstention and drift reporting, per judge version (#785, part of #396).
// Stored verdicts (v2) record each judge's model, version and prompt version; verdictHistory reports every version's
// rates overall and per condition, separately per origin, corpus version and split, plus what changed between versions;
// the log parser refuses anything that could fake a clean history. Stub models only: no key, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  calibrate, detectDrift, parseStoredVerdicts, renderVerdictHistory, toStoredVerdicts, verdictHistory, CONDITIONS, JudgeCorpusError,
  type JudgeCorpus, type JudgeSpec, type StoredVerdict,
} from '../lib/evals/judge.ts'
import { claimSupportJudge, STUB_MODELS } from './helpers/judge-stubs.ts'

const CORPUS = JSON.parse(readFileSync(new URL('./fixtures/evals/judges/corpus.synthetic.json', import.meta.url), 'utf8')) as JudgeCorpus
const V1: JudgeSpec = { id: 'claim_support', version: 1, model: 'sim-model-a', prompt_version: 1 }
const V2: JudgeSpec = { ...V1, model: 'sim-model-b' }          // a model change
const V3: JudgeSpec = { ...V2, version: 2, prompt_version: 2 } // a version and prompt change
const run = async (spec: JudgeSpec, stub: keyof typeof STUB_MODELS, id: string, day: number) =>
  toStoredVerdicts(await calibrate(claimSupportJudge(CORPUS, STUB_MODELS[stub](), spec), CORPUS), CORPUS, id, `2026-11-0${day}T00:00:00Z`)
const LOG = [...await run(V1, 'truthful', 'run-1', 1), ...await run(V1, 'truthful', 'run-2', 2), ...await run(V2, 'english_only', 'run-3', 3), ...await run(V3, 'name_matcher', 'run-4', 4)]
const jsonl = (rs: StoredVerdict[]) => rs.map(r => JSON.stringify(r)).join('\n') + '\n'

test('every version is reported with its model, version and prompt version, overall and per condition, oldest first', () => {
  const [h, ...rest] = verdictHistory(parseStoredVerdicts(jsonl(LOG)), { judge: 'claim_support' })
  assert.equal(rest.length, 0)
  assert.equal(h.origin, 'synthetic'); assert.equal(h.split, 'calibration')
  assert.deepEqual(h.versions.map(v => [v.model, v.version, v.prompt_version, v.runs]), [['sim-model-a', 1, 1, ['run-1', 'run-2']], ['sim-model-b', 1, 1, ['run-3']], ['sim-model-b', 2, 2, ['run-4']]])
  const [a, b, c] = h.versions
  for (const cond of CONDITIONS) assert.deepEqual([a.by_condition[cond].fp, a.by_condition[cond].fn, a.by_condition[cond].abstain], [0, 0, 0], `v1 ${cond}`)
  assert.equal(b.by_condition.multilingual.abstain_rate, 1, 'the model change abstains on every non-English page')
  assert.equal(b.by_condition.plain.abstain_rate, 0)
  assert.equal(c.by_condition.copied_press.fp_rate, 1, 'the version change counts a look-alike name as support')
  assert.ok(c.critical_fp.includes('cal-contact-former-neg') && c.critical_fp.includes('cal-date-neg'))
  assert.equal(c.overall.n, CORPUS.items.filter(i => i.split === 'calibration').length)
  assert.deepEqual(a.unstable, [], 'v1 answered the same in both its runs')
})

test('changes between consecutive versions are reported per condition, with the items whose answer changed and new critical false positives', () => {
  const [h] = verdictHistory(LOG, { judge: 'claim_support' })
  const [ab, bc] = h.changes
  assert.equal(ab.from, h.versions[0].fingerprint); assert.equal(ab.to, h.versions[1].fingerprint)
  assert.deepEqual(ab.by_condition.multilingual, { fp_rate: 0, fn_rate: 0, abstain_rate: 1 })
  assert.deepEqual(ab.new_critical_fp, [])
  assert.ok(ab.flipped.includes('cal-ml-pos'))
  assert.equal(bc.by_condition.copied_press!.fp_rate, 1)
  assert.ok(bc.new_critical_fp.includes('cal-copy-neg'))
  const text = renderVerdictHistory([h])
  for (const s of ['sim-model-a v1/p1', 'sim-model-b v2/p2', 'multilingual', 'change ', 'multilingual abstain_rate +100pt', 'limit: rates are agreement with developer-written labels, not ground truth', 'limit: synthetic fixtures only']) assert.ok(text.includes(s), s)
})

test('drift within one version is reported: the same fingerprint answering differently is listed as unstable, and detectDrift gives per-condition rates and versions', async () => {
  const silent = await run(V1, 'english_only', 'run-5', 5) // same fingerprint as v1, new behaviour
  const [h] = verdictHistory([...LOG.filter(r => r.run !== 'run-3' && r.run !== 'run-4'), ...silent], { judge: 'claim_support' })
  assert.equal(h.versions.length, 1)
  assert.ok(h.versions[0].unstable.includes('cal-ml-pos'), h.versions[0].unstable.join(','))
  const [d] = detectDrift([...LOG.slice(0, 46), ...silent], { judge: 'claim_support' })
  assert.equal(d.status, 'drifted')
  assert.deepEqual([d.baseline!.version, d.baseline!.prompt_version, d.latest!.model], [1, 1, 'sim-model-a'])
  assert.equal(d.by_condition.multilingual!.baseline.abstain_rate, 0)
  assert.equal(d.by_condition.multilingual!.latest.abstain_rate, 1)
})

test('origins, corpus versions and splits are reported separately, never pooled', async () => {
  const live = LOG.map(r => ({ ...r, origin: 'live' as const }))
  const hold = toStoredVerdicts(await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), V1), CORPUS, { split: 'holdout' }), CORPUS, 'run-h', '2026-11-06T00:00:00Z')
  const hs = verdictHistory([...LOG, ...live, ...hold], { judge: 'claim_support' })
  assert.deepEqual(hs.map(h => [h.origin, h.split]), [['live', 'calibration'], ['synthetic', 'calibration'], ['synthetic', 'holdout']])
  assert.ok(hs[0].limits.some(l => /live-web results: never compared with synthetic ones/.test(l)))
  assert.deepEqual(verdictHistory(LOG, { judge: 'scan_verification_judge' }), [])
})

test('the verdict log parser refuses anything that could fake a clean history', () => {
  const good = LOG[0]
  const line = (o: unknown) => JSON.stringify(o)
  const bad: [string, string, RegExp][] = [
    ['v1 record', line({ ...good, v: 1 }), /a v1 record has no judge version/],
    ['extra field', line({ ...good, send_email: 'x' }), /not a stored judge verdict/],
    ['missing field', line(Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'version'))), /not a stored judge verdict/],
    ['version as text', line({ ...good, version: '1' }), /not a stored judge verdict/],
    ['negative version', line({ ...good, version: -1 }), /not a stored judge verdict/],
    ['fractional prompt version', line({ ...good, prompt_version: 1.5 }), /not a stored judge verdict/],
    ['NaN-like time', line({ ...good, at: 'yesterday' }), /not a stored judge verdict/],
    ['no reasons', line({ ...good, reasons: [] }), /not a stored judge verdict/],
    ['unknown reason', line({ ...good, reasons: ['trust-me'] }), /not a stored judge verdict/],
    ['unknown critical kind', line({ ...good, critical: 'vibes' }), /not a stored judge verdict/],
    ['huge field', line({ ...good, item: 'x'.repeat(10_000) }), /not a stored judge verdict/],
    ['empty run id', line({ ...good, run: '' }), /not a stored judge verdict/],
    ['an array', line([good]), /not a stored judge verdict/],
    ['null', 'null', /not a stored judge verdict/],
    ['a number', '42', /not a stored judge verdict/],
    ['a cut-off line (concurrent append)', line(good).slice(0, 40), /not JSON/],
    ['a replayed line', line(LOG[1]), /duplicate verdict for .* in run run-1 \(a replayed line\)/],
    ['a run that mixes judge identities', line({ ...LOG[1], item: 'cal-new', model: 'sim-model-z' }), /run run-1 mixes judge identities/],
    ['an edited label', line({ ...LOG[24], label: LOG[24].label === 'supported' ? 'not_supported' : 'supported' }), /two different labels for one corpus version \(an edited log\)/],
  ]
  for (const [what, l, re] of bad) assert.throws(() => parseStoredVerdicts(jsonl(LOG.slice(0, 23)) + l + '\n'), (e: unknown) => e instanceof JudgeCorpusError && re.test((e as Error).message), what)
  assert.throws(() => parseStoredVerdicts(42 as never), /not text/)
  assert.deepEqual(parseStoredVerdicts(jsonl(LOG)), LOG, 'a clean log round-trips')
  assert.deepEqual(parseStoredVerdicts(jsonl(LOG).replace(/\n/g, '\r\n')), LOG, 'CRLF line ends are fine')
  assert.throws(() => toStoredVerdicts({ corpus: { hash: 'x' } } as never, CORPUS, 'r', '2026-11-01T00:00:00Z'), /report and corpus differ/)
})

test('a stored run needs a run id and a real time', async () => {
  const r = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), V1), CORPUS)
  assert.throws(() => toStoredVerdicts(r, CORPUS, '', '2026-11-01T00:00:00Z'), /needs a run id and a valid time/)
  assert.throws(() => toStoredVerdicts(r, CORPUS, 'r', 'not a time'), /needs a run id and a valid time/)
})
