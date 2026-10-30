// The blinded, equal-budget benchmark runner (lib/benchmark/runner.ts, #397) over SYNTHETIC fixtures only: no network, no
// model, no account. Every adapter here is a local stub or a fixture replay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  batchFromFile, canonicalize, fixtureAdapter, freezeBriefs, memoryStore, runBatch, unavailableAdapter,
  BenchmarkRunError, type Adapter, type AdapterResult, type BatchFile, type BlindEvaluator, type BlindItem, type Brief, type Limits,
} from '../lib/benchmark/runner.ts'

const FILE = new URL('./fixtures/benchmark/synthetic-batch.json', import.meta.url)
const BATCH = JSON.parse(readFileSync(FILE, 'utf8')) as BatchFile
const base = () => batchFromFile(structuredClone(BATCH))
const ok = (items: AdapterResult['items'] = [], over: Partial<AdapterResult> = {}): AdapterResult => ({ items, cost_usd: 0.1, seconds: 1, interventions: 0, ...over })
// A stub adapter that records what it was given.
const spy = (system: string, fn: (b: Brief, l: Limits) => Promise<AdapterResult> = async () => ok()) => {
  const calls: { brief: Brief; limits: Limits }[] = []
  const a: Adapter = { system, origin: 'synthetic', available: { ok: true }, config: { product: system, product_version: 'stub', model: null, sources: [], paid: false }, run: async (b, l) => { calls.push({ brief: b, limits: l }); return fn(b, l) } }
  return { a, calls }
}
const allPass: BlindEvaluator = { name: 'all-pass', version: '1', independent: true, judge: async items => Object.fromEntries(items.map(i => [i.blind_id, { identity: 'pass', constraints: 'pass', event_date: 'pass', contact: 'pass' }])) }

test('the synthetic batch reproduces: same report from the same inputs, every system scored by #372\'s scorecard', async () => {
  const a = await runBatch(base()), b = await runBatch(base())
  assert.deepEqual(a.report, b.report); assert.equal(a.manifest.batch_id, b.manifest.batch_id)
  const r = Object.fromEntries(a.report.map(x => [x.system, x]))
  assert.deepEqual([r.dazl.complete, r.dazl.validated, r.dazl.unique_actionable_yield, r.dazl.precision_at_10, r.dazl.spend_usd, r.dazl.interventions], [3, 2, 1, 0.5, 1.3, 0])
  assert.deepEqual([r['chatgpt-web-baseline'].complete, r['chatgpt-web-baseline'].validated, r['chatgpt-web-baseline'].unique_actionable_yield, r['chatgpt-web-baseline'].spend_usd, r['chatgpt-web-baseline'].interventions], [3, 2, 1, null, 4])
  assert.equal(a.scorecards.length, 4); assert.ok(a.scorecards.every(c => c.format === 'dazl-benchmark-scorecard'))
  // the negative task: the baseline's invented IPO is not validated, so it is not a false alert; it IS a returned result
  const neg = a.scorecards.find(c => c.system === 'chatgpt-web-baseline')!.tasks.find(t => t.task_id === 'negative-reykjavik-ipo')!
  assert.deepEqual([neg.returned, neg.validated, neg.false_alerts], [1, 0, 0])
})

test('equal budget and the same frozen brief for every system; the briefs are hashed before any run', async () => {
  const x = spy('alpha'), y = spy('beta')
  const r = await runBatch({ ...base(), adapters: [x.a, y.a], evaluator: allPass })
  assert.equal(x.calls.length, 4); assert.equal(y.calls.length, 4)
  for (let i = 0; i < 4; i++) {
    assert.equal(x.calls[i].brief, y.calls.find(c => c.brief.task_id === x.calls[i].brief.task_id)!.brief) // the identical object
    assert.deepEqual(x.calls[i].limits, { usd: 2, seconds: 30 }); assert.deepEqual(y.calls[i].limits, { usd: 2, seconds: 30 })
  }
  assert.ok(Object.isFrozen(x.calls[0].brief) && Object.isFrozen(x.calls[0].brief.constraints))
  assert.throws(() => { (x.calls[0].brief as { query: string }).query = 'changed' })
  assert.equal(x.calls[0].brief.as_of, '2026-10-20'); assert.equal(x.calls.find(c => c.brief.task_id === 'london-seed-saas')!.brief.window_days, 60)
  assert.equal(r.manifest.briefs_hash, freezeBriefs(base().set, '2026-10-20').hash)
  // any change to the briefs is a different batch
  const other = structuredClone(BATCH); other.task_set.tasks[0].query += ' (edited)'
  assert.notEqual((await runBatch({ ...batchFromFile(other), adapters: [spy('alpha').a], evaluator: allPass })).manifest.batch_id, (await runBatch({ ...base(), adapters: [spy('alpha').a], evaluator: allPass })).manifest.batch_id)
})

test('the run order rotates per task, so every system goes first equally often', async () => {
  const order: string[] = []
  const mk = (s: string) => spy(s, async () => { order.push(s); return ok() }).a
  const r = await runBatch({ ...base(), adapters: [mk('a'), mk('b'), mk('c'), mk('d')], evaluator: allPass })
  const firsts = Object.values(r.manifest.order).map(o => o[0])
  assert.deepEqual([...firsts].sort(), ['a', 'b', 'c', 'd'])
  assert.deepEqual(order.slice(0, 4), r.manifest.order['toronto-agency-office'])
})

test('idempotent: a re-run with the same store calls nothing again and reports the same', async () => {
  const store = memoryStore(); const x = spy('alpha', async () => ok([{ company: 'Querix', domain: 'querix.example' }]))
  const a = await runBatch({ ...base(), adapters: [x.a], evaluator: allPass, store })
  const b = await runBatch({ ...base(), adapters: [x.a], evaluator: allPass, store })
  assert.equal(x.calls.length, 4); assert.equal(store.runs.size, 4)
  assert.deepEqual(a.report, b.report); assert.equal(a.spent_usd, b.spent_usd)
})

test('a missing adapter is unavailable with its reason, never a zero-result loser', async () => {
  const r = await runBatch(base())
  const p = r.report.find(s => s.system === 'pancake')!
  assert.deepEqual([p.status, p.coverage, p.precision_at_10, p.spend_usd], ['unavailable', null, null, null])
  assert.match(p.reason!, /no authorized Pancake account/)
  const card = r.scorecards.find(c => c.system === 'pancake')!
  assert.ok(card.tasks.every(t => t.status === 'unsupported' && /adapter unavailable/.test(t.reason!) && t.precision_at_10 === null))
  assert.equal(card.totals.complete, 0)
})

test('stops are not empty markets: budget/timeout/rate -> incomplete, login/paywall/feature -> unsupported (never bypassed), errors -> failed', async () => {
  const stops: Record<string, Partial<AdapterResult> | 'throw' | 'hang'> = { 'toronto-agency-office': { stopped: 'rate_limited' }, 'london-seed-saas': { stopped: 'login_required', detail: 'the product asks for a login' }, 'munich-maschinenbau': 'throw', 'negative-reykjavik-ipo': 'hang' }
  const x = spy('alpha', async b => { const s = stops[b.task_id]; if (s === 'throw') throw new Error('500 from the product API'); if (s === 'hang') return new Promise<AdapterResult>(() => {}); return ok([], s) })
  const r = await runBatch({ ...base(), budget: { ...base().budget, seconds_per_task: 0.05 }, adapters: [x.a], evaluator: allPass })
  const t = Object.fromEntries(r.scorecards[0].tasks.map(t => [t.task_id, [t.status, t.reason, t.precision_at_10]]))
  assert.deepEqual(t['toronto-agency-office'], ['incomplete', 'rate_limited', null])
  assert.deepEqual(t['london-seed-saas'], ['unsupported', 'login_required (never bypassed): the product asks for a login', null])
  assert.deepEqual(t['munich-maschinenbau'], ['failed', 'adapter error: 500 from the product API', null])
  assert.deepEqual(t['negative-reykjavik-ipo'], ['incomplete', 'timeout after 0.05s', null])
  assert.equal(r.scorecards[0].totals.complete, 0)
  assert.equal(r.scorecards[0].totals.false_alerts, 0); assert.equal(r.scorecards[0].totals.negative_tasks_complete, 0) // a hung negative task is not a clean pass
})

test('blind scoring: the evaluator never sees a system, product, model or config, and items are pooled across systems', async () => {
  const seen: BlindItem[][] = []
  const spyEval: BlindEvaluator = { ...allPass, judge: async (items, b) => { seen.push(items); return allPass.judge(items, b) } }
  await runBatch({ ...base(), evaluator: spyEval })
  const blob = JSON.stringify(seen)
  for (const s of ['dazl', 'chatgpt', 'baseline', 'pancake', 'synthetic-1', 'web browsing', 'SYNTHETIC fixture']) assert.ok(!blob.includes(s), s)
  for (const items of seen) for (const i of items) assert.deepEqual(Object.keys(i).sort(), ['blind_id', 'company', 'contact', 'domain', 'event_date', 'evidence_urls', 'text'])
  assert.equal(seen[0].length, 4) // Toronto: two from each system in one pool
  // an evaluator that throws or omits an item yields unknown, never pass
  const broken: BlindEvaluator = { ...allPass, judge: async () => { throw new Error('judge down') } }
  const r = await runBatch({ ...base(), evaluator: broken })
  assert.ok(r.report.every(s => s.validated === 0))
})

test('canonicalisation keeps the raw output beside one row per entity (domain first, then the normalised name)', () => {
  const c = canonicalize([{ company: 'Querix Ltd', domain: 'https://www.Querix.example/about' }, { company: 'Querix', domain: 'querix.example' }, { company: 'Isar Werkzeugbau GmbH' }, { company: '  ' }, { company: 'Café Ölmühle', event_date: 'last week' }])
  assert.deepEqual(c.map(x => [x.rank, x.entity_key, x.event_date]), [[1, 'domain:querix.example', null], [2, 'name:isar werkzeugbau', null], [3, 'name:cafe olmuhle', null]])
  assert.deepEqual(c[0].raw, { company: 'Querix Ltd', domain: 'https://www.Querix.example/about' })
})

test('durable budget: the batch total is reserved before each task; a paid live adapter needs authorization and a budget', async () => {
  const x = spy('alpha', async () => ok([], { cost_usd: null }))      // unknown cost: the whole task limit is reserved
  const r = await runBatch({ ...base(), budget: { usd_per_task: 2, seconds_per_task: 30, batch_usd: 5 }, adapters: [x.a], evaluator: allPass })
  assert.equal(x.calls.length, 2)
  assert.deepEqual(r.scorecards[0].tasks.map(t => t.status), ['complete', 'complete', 'not_run', 'not_run'])
  assert.match(r.scorecards[0].tasks[2].reason!, /batch budget reached/)
  assert.equal(r.spent_usd, 4)
  const paid: Adapter = { ...spy('live-paid').a, origin: 'live', config: { product: 'p', product_version: null, model: null, sources: [], paid: true } }
  const off = await runBatch({ ...base(), adapters: [paid], evaluator: allPass })
  assert.match(off.report[0].reason!, /paid run needs explicit authorization/)
  await assert.rejects(runBatch({ ...base(), budget: { usd_per_task: 0, seconds_per_task: 30, batch_usd: 5 } }), (e: unknown) => e instanceof BenchmarkRunError)
  await assert.rejects(runBatch({ ...base(), budget: { usd_per_task: 2, seconds_per_task: 30, batch_usd: Infinity } }), /preset/)
})

test('origin is never upgraded: synthetic and live never share a batch, a fixture is never live, synthetic scorecards are not evaluable', async () => {
  const live: Adapter = { ...spy('live').a, origin: 'live' }
  await assert.rejects(runBatch({ ...base(), adapters: [...base().adapters, live] }), /one batch, one origin/)
  assert.throws(() => fixtureAdapter({ ...BATCH.systems[0], origin: 'live' as 'synthetic' }), /never be live/)
  const r = await runBatch(base())
  assert.equal(r.manifest.label, 'SYNTHETIC fixtures: not live results of any product')
  assert.ok(r.scorecards.every(c => c.origin === 'synthetic' && !c.evaluable && /synthetic data/.test(c.not_evaluable_reason!)))
  assert.throws(() => batchFromFile({ ...structuredClone(BATCH), systems: BATCH.systems.map(s => ({ ...s, origin: 'recorded' as const })) }), /labels are ground truth only for synthetic/)
  assert.equal(unavailableAdapter('x', 'r', 'synthetic').available.ok, false)
})

test('one command reproduces the scored batch; --store resumes without calling anything again', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-run-'))
  try {
    const run = () => execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/benchmark.mts', 'run', '--batch', FILE.pathname, '--store', path.join(dir, 'store.json'), '--out', dir], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
    const first = run(), second = run()
    assert.match(first, /SYNTHETIC fixtures: not live results/); assert.match(first, /runs: 16 new, 0 reused/)
    assert.match(second, /runs: 0 new, 16 reused/)
    assert.equal(first.split('\n\nruns:')[0], second.split('\n\nruns:')[0])
    assert.match(first, /\| pancake \| unavailable: no authorized Pancake account/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
