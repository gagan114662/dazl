// The blinded, equal-budget benchmark runner (lib/benchmark/runner.ts, #397) over SYNTHETIC fixtures only: no network, no
// model, no account. Every adapter here is a local stub or a fixture replay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  batchFromFile, canonicalize, contractEvaluator, contractVerdicts, CONTRACT_FIELDS, fixtureAdapter, freezeBriefs, memoryStore, runBatch, unavailableAdapter,
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
    assert.deepEqual(x.calls[i].limits, { usd: 2, seconds: 45 }); assert.deepEqual(y.calls[i].limits, { usd: 2, seconds: 45 })
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
  for (const items of seen) for (const i of items) assert.deepEqual(Object.keys(i).sort(), ['blind_id', 'company', 'contact', 'contact_source_url', 'domain', 'event_date', 'event_source_url', 'evidence_urls', 'person', 'quotes', 'text', 'unchecked'])
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
  const off = await runBatch({ ...base(), adapters: [paid], evaluator: allPass, committedSet: base().set })
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

test('blinding: system, product and model names are scrubbed from what the evaluator reads; an evidence URL naming one is withheld', async () => {
  const seen: BlindItem[] = []
  const x = spy('alpha', async b => ok(b.task_id === 'toronto-agency-office' ? [{ company: 'Querix', domain: 'querix.example', contact: 'leads via Alpha', text: 'Found by Alpha Prospector (GPT-4o-mini): Querix opened a Toronto office', evidence_urls: ['https://news.example/querix', 'https://alpha.example/lead/1'] }] : []))
  x.a.config = { ...x.a.config, product: 'Alpha Prospector', model: 'gpt-4o-mini' }
  const r = await runBatch({ ...base(), adapters: [x.a], evaluator: { ...allPass, judge: async (items, b) => { seen.push(...items); return allPass.judge(items, b) } } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, 'Found by [system] ([system]): Querix opened a Toronto office')
  assert.equal(seen[0].contact, 'leads via [system]')
  assert.deepEqual(seen[0].evidence_urls, ['https://news.example/querix', '[evidence url withheld: names a system]'])
  assert.deepEqual([seen[0].company, seen[0].domain], ['Querix', 'querix.example']) // the lead itself is not altered
  assert.deepEqual(r.manifest.blinding, { identity_tokens: 3, redactions: 4 })
  // blinding changes only what the evaluator is shown: the run records the lead, and the judgement maps back to its system
  assert.match(JSON.stringify(r.runs[0].tasks), /querix/); assert.equal(r.evaluations[0].system, 'alpha')
})

test('frozen task set: a recorded or live batch must run the committed set unchanged; a synthetic batch given one must match it', async () => {
  const rec = fixtureAdapter({ ...structuredClone(BATCH.systems[0]), origin: 'recorded' })
  const committed = structuredClone(BATCH.task_set)
  await assert.rejects(runBatch({ ...base(), adapters: [rec], evaluator: allPass }), /must run a committed frozen task set/)
  const edited = structuredClone(committed); edited.tasks[1].query += ' (edited)'
  await assert.rejects(runBatch({ ...base(), adapters: [rec], evaluator: allPass, committedSet: edited }), /differs from the committed frozen one/)
  const reordered = { ...structuredClone(committed), tasks: committed.tasks.map(t => Object.fromEntries(Object.entries(t).reverse())) as typeof committed.tasks }
  assert.equal((await runBatch({ ...base(), adapters: [rec], evaluator: allPass, committedSet: reordered })).manifest.origin, 'recorded') // key order is not a change
  await assert.rejects(runBatch({ ...base(), committedSet: edited }), /differs/)
  await assert.rejects(runBatch({ ...base(), set: { ...committed, tasks: [committed.tasks[0], committed.tasks[0]] } }), /repeats a task id/)
  // the CLI looks the committed set up by version: a batch that claims v1 but edits it is invalid_input, nothing run
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-frozen-'))
  try {
    const v1 = JSON.parse(readFileSync(new URL('../../scoreboard/benchmark/v1/tasks.json', import.meta.url), 'utf8'))
    v1.tasks[0].query += ' (edited)'
    const f = path.join(dir, 'b.json'); writeFileSync(f, JSON.stringify({ ...structuredClone(BATCH), task_set: { version: v1.version, frozen_at: v1.frozen_at, tasks: v1.tasks } }))
    const res = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/benchmark.mts', 'run', '--batch', f], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
    assert.equal(res.status, 2); assert.match(res.stderr, /invalid_input: the batch's task set v1 differs from the committed frozen one/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('equal time limit: a self-reported time over the task limit is incomplete, like a cost over it', async () => {
  const x = spy('alpha', async () => ok([{ company: 'Querix', domain: 'querix.example' }], { seconds: 46 }))
  const r = await runBatch({ ...base(), adapters: [x.a], evaluator: allPass })
  assert.ok(r.scorecards[0].tasks.every(t => t.status === 'incomplete' && /over the task time limit \(46s > 45s\)/.test(t.reason!)))
  assert.equal(r.report[0].validated, 0)
})

test('scoring hook: a #394 contract scorer judges blind items; the worst contract field decides, unscored is unknown, every record is kept', async () => {
  // A stub with the shape of lib/evals/contract.ts evaluateLead (#394): per-field verdicts, a tier, the scorer.
  const statuses: Record<string, Record<string, string>> = {
    'mapleleaf.example': { 'identity.entity': 'pass', 'source.on_page': 'pass', 'event.date_real': 'pass', 'place.matches': 'pass', 'event.predicate': 'pass', 'event.date_in_window': 'pass', 'contact.usable': 'pass', 'consent.status': 'pass' },
    'lakeshore.example': { 'identity.entity': 'pass', 'source.on_page': 'contradicted', 'event.date_real': 'pass', 'place.matches': 'pass', 'event.predicate': 'pass', 'event.date_in_window': 'fail', 'contact.usable': 'garbled' },
  }
  const evaluated: string[] = []
  const hook = contractEvaluator<{ id: string }, { company: string; domain: string | null }>({
    name: 'eval-contract', version: '1',
    contractFor: b => b.task_id === 'london-seed-saas' ? null : { id: `contract-${b.task_id}` },
    evidenceFor: it => ({ company: it.company, domain: it.domain }),
    evaluate: (c, e) => {
      evaluated.push(c.id)
      const s = statuses[e.domain ?? ''] ?? {}
      return { contract: c.id, contract_hash: `hash-${c.id}`, tier: e.domain === 'mapleleaf.example' ? 'actionable_opportunity' : null, status: 'unknown', scorer: { id: 'contract-scorer', version: 1 }, verdicts: Object.entries(s).map(([field, status]) => ({ field, status, rationale: 'stub' })) }
    },
  })
  const r = await runBatch({ ...base(), evaluator: hook })
  const ev = (sys: string, key: string) => r.evaluations.find(e => e.system === sys && e.entity_key === key)!
  assert.deepEqual(ev('dazl', 'domain:mapleleaf.example').verdicts, { identity: 'pass', constraints: 'pass', event_date: 'pass', contact: 'pass' })
  assert.equal((ev('dazl', 'domain:mapleleaf.example').record as { tier: string }).tier, 'actionable_opportunity')
  assert.equal((ev('dazl', 'domain:mapleleaf.example').record as { contract_hash: string }).contract_hash, 'hash-contract-' + ev('dazl', 'domain:mapleleaf.example').task_id, 'the frozen contract hash is persisted with the judgement (#394 review)')
  // contradicted beats pass, fail beats pass, an unknown status string is unknown
  assert.deepEqual(ev('dazl', 'domain:lakeshore.example').verdicts, { identity: 'contradicted', constraints: 'pass', event_date: 'fail', contact: 'unknown' })
  // a lead the contract scored nothing for is unknown on every field, never pass
  assert.deepEqual(ev('chatgpt-web-baseline', 'domain:northernlights.example').verdicts, { identity: 'unknown', constraints: 'unknown', event_date: 'unknown', contact: 'unknown' })
  // no contract for the task: unknown, the reason recorded, and the scorer was never called with an inferred contract
  const london = r.evaluations.filter(e => e.task_id === 'london-seed-saas')
  assert.ok(london.length > 0 && london.every(e => Object.values(e.verdicts).every(v => v === 'unknown') && /no evaluation contract/.test((e.record as { error: string }).error)))
  assert.ok(evaluated.length > 0 && !evaluated.includes('contract-london-seed-saas'))
  // only mapleleaf validates, once for each system that returned it
  assert.deepEqual(r.report.filter(s => s.status === 'ran').map(s => [s.system, s.validated]), [['chatgpt-web-baseline', 1], ['dazl', 1]])
  // the recorded evaluations cover every item of every complete task
  assert.equal(r.evaluations.length, r.runs.flatMap(x => x.tasks.filter(t => t.status === 'complete').flatMap(t => t.results)).length)
  const thrower = contractEvaluator({ name: 'c', version: '1', contractFor: () => ({}), evidenceFor: it => it, evaluate: () => { throw new Error('bad evidence') } })
  const t = await runBatch({ ...base(), evaluator: thrower })
  assert.ok(t.evaluations.every(e => /contract scorer failed: bad evidence/.test((e.record as { error: string }).error) && e.verdicts.identity === 'unknown'))
  assert.ok(t.report.every(s => s.validated === 0))
})

test('contractVerdicts maps the #394 field names onto the scorecard fields', () => {
  const e = (vs: [string, string][]) => ({ contract: 'c', tier: null, status: 'unknown' as const, scorer: { id: 's', version: 1 }, verdicts: vs.map(([field, status]) => ({ field, status })) })
  assert.deepEqual(contractVerdicts(e([])), { identity: 'unknown', constraints: 'unknown', event_date: 'unknown', contact: 'unknown' })
  assert.deepEqual(contractVerdicts(e([['identity.entity', 'pass'], ['industry.matches', 'fail'], ['consent.status', 'pass'], ['event.date_real', 'unknown'], ['event.date_in_window', 'pass'], ['contact.usable', 'pass'], ['outcome.evidence', 'fail']])),
    { identity: 'pass', constraints: 'fail', event_date: 'unknown', contact: 'pass' })
  assert.deepEqual(Object.keys(CONTRACT_FIELDS).sort(), ['constraints', 'contact', 'event_date', 'identity'])
})

test('an evaluator that omits an item records why; the blind ids map back to the right system after judging', async () => {
  const half: BlindEvaluator = { ...allPass, judge: async (items, b) => { const all = await allPass.judge(items, b); return Object.fromEntries(Object.entries(all).slice(0, 1)) } }
  const r = await runBatch({ ...base(), evaluator: half })
  const missing = r.evaluations.filter(e => (e.record as { error?: string } | null)?.error === 'evaluator returned no judgement for this item')
  assert.ok(missing.length > 0 && missing.every(e => Object.values(e.verdicts).every(v => v === 'unknown')))
  for (const e of r.evaluations) assert.ok(r.runs.find(x => x.system === e.system)!.tasks.find(t => t.task_id === e.task_id)!.results.some(x => x.entity_key === e.entity_key))
})

test('a recorded failure keeps the time it measured: status failed, seconds kept for the per-tool time report (greptile P2)', async () => {
  const fx = structuredClone(BATCH.systems[0]); const id = BATCH.task_set.tasks[0].id
  fx.tasks[id] = { error: 'key_rejected', seconds: 7 }
  const r = await runBatch({ ...base(), adapters: [fixtureAdapter(fx)], evaluator: allPass })
  const t = r.scorecards[0].tasks.find(t => t.task_id === id)!
  assert.equal(t.status, 'failed'); assert.equal(t.seconds, 7)
  fx.tasks[id] = { error: 'key_rejected' }
  assert.equal((await runBatch({ ...base(), adapters: [fixtureAdapter(fx)], evaluator: allPass })).scorecards[0].tasks.find(t => t.task_id === id)!.seconds, null)
})
