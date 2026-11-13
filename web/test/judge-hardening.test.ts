// Malformed-input pass over the judge harness (lib/evals/judge.ts, #396 / #784): every bad option, lock, adapter reply,
// gate or corpus fails closed (unknown, unusable, or a JudgeCorpusError before any judge call), never a pass and never a
// TypeError. These use only the API that existed before #396's gate work, so the same file run against the earlier
// judge.ts shows which of them were real holes (see the PR's fail-before section). Stub models only; nothing leaves the
// process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  calibrate, checkCorpus, corpusHash, detectDrift, judgeFingerprint, judgeGate, judgeVerdict, parseJudgeReply, DEFAULT_THRESHOLDS, JudgeCorpusError,
  type JudgeAdapter, type JudgeCorpus, type JudgeLock, type JudgeOutcome, type JudgeSpec,
} from '../lib/evals/judge.ts'
import { claimSupportJudge, STUB_MODELS } from './helpers/judge-stubs.ts'

const DIR = new URL('./fixtures/evals/judges/', import.meta.url)
const CORPUS = JSON.parse(readFileSync(new URL('corpus.synthetic.json', DIR), 'utf8')) as JudgeCorpus
const LOCK = JSON.parse(readFileSync(new URL('judges.lock.json', DIR), 'utf8')) as JudgeLock
const SPEC: JudgeSpec = { id: 'claim_support', version: 1, model: 'sim-model-a', prompt_version: 1 }
const isCorpusError = (e: unknown) => e instanceof JudgeCorpusError
// counts every call the harness makes to the judge under test
const counted = (inner: JudgeAdapter) => { const c = { n: 0 }; return { c, adapter: { ...inner, ask: (q: Parameters<JudgeAdapter['ask']>[0]) => { c.n++; return inner.ask(q) } } as JudgeAdapter } }

test('a NaN, infinite, out-of-range, mistyped, missing or extra threshold is refused before any judge call (NaN used to pass every rate check)', async () => {
  const bad: Record<string, unknown>[] = [
    { ...DEFAULT_THRESHOLDS, max_abstain_rate: NaN, max_condition_abstain_rate: NaN },
    { ...DEFAULT_THRESHOLDS, max_fp_rate: Infinity },
    { ...DEFAULT_THRESHOLDS, max_fn_rate: -0.1 },
    { ...DEFAULT_THRESHOLDS, max_flip_rate: 2 },
    { ...DEFAULT_THRESHOLDS, max_group_flip_rate: '0.1' },
    { ...DEFAULT_THRESHOLDS, max_condition_fp_rate: null },
    Object.fromEntries(Object.entries(DEFAULT_THRESHOLDS).filter(([k]) => k !== 'max_fp_rate')),
    { ...DEFAULT_THRESHOLDS, min_agreement: 0.5 },
  ]
  for (const thresholds of bad) {
    const { c, adapter } = counted(claimSupportJudge(CORPUS, STUB_MODELS.english_only(), SPEC))
    await assert.rejects(calibrate(adapter, CORPUS, { thresholds: thresholds as never }), isCorpusError, JSON.stringify(thresholds))
    assert.equal(c.n, 0, 'nothing is asked under a bad threshold')
  }
})

test('a bad repeat count, budget, split or flag is refused before any judge call (NaN repeats used to crash, NaN budget used to be unlimited)', async () => {
  for (const o of [{ repeats: NaN }, { repeats: 0 }, { repeats: 1.5 }, { repeats: 11 }, { repeats: '2' }, { maxCalls: NaN }, { maxCalls: -1 }, { maxCalls: Infinity }, { maxCalls: 2.5 }, { split: 'test' }, { reverseSources: 'yes' }]) {
    const { c, adapter } = counted(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), SPEC))
    await assert.rejects(calibrate(adapter, CORPUS, o as never), isCorpusError, JSON.stringify(o))
    assert.equal(c.n, 0, `nothing is asked under ${JSON.stringify(o)}`)
  }
})

test('an adapter that answers outside {supported, not_supported, unknown} is unknown, so it can no longer pass with zero fp/fn/abstain', async () => {
  for (const reply of [{ answer: 'yes', quote: null, source: null, reason: 'ok' }, { answer: 'supported', quote: null, source: null, reason: 'trust-me' }, null, 'supported', 42, ['supported']]) {
    const garbage: JudgeAdapter = { spec: SPEC, template: 't', quotes: false, ask: async () => reply as unknown as JudgeOutcome }
    const r = await calibrate(garbage, CORPUS)
    assert.equal(r.ok, false, JSON.stringify(reply))
    assert.equal(r.overall.abstain, r.overall.n, 'every malformed answer counts as an abstention')
    assert.ok(Object.values(r.items).every(i => i.attempts.every(a => a.answer === 'unknown' && a.reason === 'unparseable')))
  }
})

test('an adapter that throws is unknown on that attempt and the run still completes and records every item', async () => {
  let n = 0
  const throwing: JudgeAdapter = { spec: SPEC, template: 't', quotes: false, ask: async () => { if (n++ % 3 === 0) throw Object.assign(new Error('boom'), { errno: undefined }); return { answer: 'not_supported', quote: null, source: null, reason: 'ok' } } }
  const r = await calibrate(throwing, CORPUS)
  assert.equal(Object.keys(r.items).length, CORPUS.items.filter(i => i.split === 'calibration').length)
  assert.ok(Object.values(r.items).some(i => i.attempts.some(a => a.reason === 'error')))
  assert.equal(r.ok, false)
})

test('unknown never becomes pass by majority: two supported attempts and one unknown is unknown', async () => {
  const seq = ['supported', 'supported', 'unknown'] as const
  let n = 0
  const twoOfThree: JudgeAdapter = { spec: SPEC, template: 't', quotes: true, ask: async () => ({ answer: seq[n++ % 3], quote: null, source: null, reason: 'ok' }) }
  const r = await calibrate(twoOfThree, CORPUS, { repeats: 3, reverseSources: false })
  assert.ok(Object.values(r.outcomes).every(a => a === 'unknown'))
  assert.equal(r.overall.fp, 0)
  assert.equal(r.ok, false)
})

test('the gate is unusable for a lock entry that is not a clean, explicit pass, and for a malformed lock (a truthy "ok" used to make a judge count)', () => {
  const j = claimSupportJudge(CORPUS, STUB_MODELS.truthful(), SPEC)
  const fp = judgeFingerprint(SPEC, j.template)
  const entry = { fingerprint: fp, judge: SPEC, corpus_hash: corpusHash(CORPUS), origin: 'synthetic', ok: true, problems: [], critical_fp: [], source: 'test', calibrated_at: '2026-11-10T00:00:00Z' }
  assert.equal(judgeGate(j, { ...LOCK, judges: [entry] } as JudgeLock, CORPUS).usable, true, 'the clean entry counts')
  for (const bad of [{ ok: 'yes' }, { ok: 1 }, { ok: true, problems: ['critical false positive: cal-date-neg'] }, { ok: true, problems: 'none' }, { ok: true, critical_fp: ['cal-date-neg'] }, { ok: true, critical_fp: undefined }]) {
    assert.equal(judgeGate(j, { ...LOCK, judges: [{ ...entry, ...bad }] } as unknown as JudgeLock, CORPUS).usable, false, JSON.stringify(bad))
  }
  for (const lock of [null, {}, { ...LOCK, judges: null }, { ...LOCK, judges: [null] }, { ...LOCK, registered: 'x' }, { ...LOCK, kind: 'other' }]) {
    assert.equal(judgeGate(j, lock as unknown as JudgeLock, CORPUS).usable, false, JSON.stringify(lock))
  }
  assert.equal(judgeGate(j, { ...LOCK, judges: [entry] } as JudgeLock, CORPUS, [{ judge: SPEC.id, status: 'weird' }] as never).usable, false, 'an unreadable drift status is not stable')
})

test('a verdict passes only from a gate that is exactly usable: true, and malformed outcomes are unknown', () => {
  const ev = { id: 'claim_supported', version: 1 }
  const sup: JudgeOutcome = { answer: 'supported', quote: 'raised a seed round', source: 1, reason: 'ok' }
  for (const gate of [{ usable: 'true', reason: 'x' }, { usable: 1, reason: 'x' }, null, undefined]) assert.equal(judgeVerdict(ev, 's', gate as never, [sup, sup]).status, 'unknown', JSON.stringify(gate))
  const on = { usable: true, reason: 'calibrated' }
  for (const outs of [[sup, null], [sup, 'supported'], null, 'supported']) assert.equal(judgeVerdict(ev, 's', on, outs as never).status, 'unknown', JSON.stringify(outs))
  assert.equal(judgeVerdict(ev, 's', on, [sup, sup]).status, 'pass')
})

test('a malformed corpus is a JudgeCorpusError, never a TypeError', () => {
  const item = structuredClone(CORPUS.items[0])
  for (const c of [null, 'corpus', [], { ...CORPUS, items: null }, { ...CORPUS, items: [null, ...CORPUS.items] }, { ...CORPUS, items: [{ ...item, sources: [{ url: 'u', text: 42 }] }, ...CORPUS.items.slice(1)] },
    { ...CORPUS, items: [{ ...item, sources: 'x' }, ...CORPUS.items.slice(1)] }, { ...CORPUS, items: [{ ...item, claim: '' }, ...CORPUS.items.slice(1)] }, { ...CORPUS, items: [{ ...item, quote: 7 }, ...CORPUS.items.slice(1)] }]) {
    assert.throws(() => checkCorpus(c as never), isCorpusError, JSON.stringify(c).slice(0, 80))
  }
})

test('drift: a NaN or out-of-range tolerance is refused (it would hide or invent every rate change)', async () => {
  const r = await calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), SPEC), CORPUS)
  const recs = Object.keys(r.items).map(item => ({ v: 2, run: 'run-1', at: '2026-11-01T00:00:00Z', judge: SPEC.id, fingerprint: r.fingerprint, model: SPEC.model, version: 1, prompt_version: 1, corpus_hash: r.corpus.hash, origin: 'synthetic', split: 'calibration', item, condition: CORPUS.items.find(i => i.id === item)!.condition, critical: null, label: 'supported', answer: r.items[item].answer, reasons: ['ok'] }))
  for (const tolerance of [NaN, -0.1, 1.5, Infinity]) assert.throws(() => detectDrift(recs as never, { judge: SPEC.id, tolerance }), isCorpusError, String(tolerance))
  assert.throws(() => detectDrift(null as never, { judge: SPEC.id }), isCorpusError)
})

test('huge, empty and odd replies stay unknown; a huge verbatim quote still has to be on the page', () => {
  const src = [{ url: 'u', text: 'Querix raised a 3m GBP seed round in October 2026.' }]
  assert.equal(parseJudgeReply('', src).reason, 'unparseable')
  assert.equal(parseJudgeReply('{}', src).reason, 'unparseable')
  assert.equal(parseJudgeReply('null', src).reason, 'unparseable')
  assert.equal(parseJudgeReply(JSON.stringify({ answer: 'supported', quote: 'x'.repeat(1_000_000), source: 1 }), src).reason, 'quote_not_in_source')
  assert.equal(parseJudgeReply(JSON.stringify({ answer: 'supported', quote: 'raised a 3m GBP seed round', source: 1.5 }), src).reason, 'unparseable')
  assert.equal(parseJudgeReply(JSON.stringify({ answer: 'supported', quote: 'raised a 3m GBP seed round', source: '1' }), src).reason, 'unparseable')
  assert.equal(parseJudgeReply('\uFFFD\uFFFD', src).reason, 'unparseable')
})

test('concurrent calibrations of independent judges do not interfere, and never mutate the corpus', async () => {
  const before = structuredClone(CORPUS)
  const [a, b, c] = await Promise.all([calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), SPEC), CORPUS), calibrate(claimSupportJudge(CORPUS, STUB_MODELS.truthful(), SPEC), CORPUS), calibrate(claimSupportJudge(CORPUS, STUB_MODELS.name_matcher(), SPEC), CORPUS)])
  assert.deepEqual(a, b)
  assert.equal(a.ok, true); assert.equal(c.ok, false)
  assert.deepEqual(CORPUS, before, 'reversed-source attempts reverse a copy')
})
