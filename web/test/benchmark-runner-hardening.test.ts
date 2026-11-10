// Runner hardening for recorded inputs (#397): every case here fails on the runner before this change (a malformed
// recorded output crashed or corrupted the batch, an available system that started nothing was reported as `ran`, and
// the evaluator never received the provenance the verifier re-reads). SYNTHETIC stubs only: no network, model or account.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { batchFromFile, runBatch, type Adapter, type AdapterResult, type BatchFile, type BlindEvaluator, type BlindItem, type Brief } from '../lib/benchmark/runner.ts'

const BATCH = JSON.parse(readFileSync(new URL('./fixtures/benchmark/synthetic-batch.json', import.meta.url), 'utf8')) as BatchFile
const base = () => batchFromFile(structuredClone(BATCH))
const allPass: BlindEvaluator = { name: 'all-pass', version: '1', independent: true, judge: async items => Object.fromEntries(items.map(i => [i.blind_id, { identity: 'pass', constraints: 'pass', event_date: 'pass', contact: 'pass' }])) }
const stub = (system: string, run: (b: Brief) => Promise<unknown>, supports?: (b: Brief) => true | string): Adapter => ({
  system, origin: 'synthetic', available: { ok: true }, config: { product: system, product_version: 'stub', model: null, sources: [], paid: false },
  run: run as (b: Brief) => Promise<AdapterResult>, ...(supports ? { supports } : {}),
})

test('a malformed adapter result fails that task, recorded, with the full task limit reserved; the batch still scores', async () => {
  const bad: Record<string, unknown> = {
    'toronto-agency-office': { items: [], cost_usd: '0.5', seconds: 1, interventions: 0 },       // a cost as a string
    'london-seed-saas': { items: 'none', cost_usd: 0.1, seconds: 1, interventions: 0 },           // items not a list
    'munich-maschinenbau': { items: [], cost_usd: 0.1, seconds: 1, interventions: -1 },          // negative interventions
    'negative-reykjavik-ipo': { items: [], cost_usd: 0.1, seconds: 1, interventions: 0, stopped: 'bored' },   // an unknown stop
  }
  const r = await runBatch({ ...base(), adapters: [stub('alpha', async b => bad[b.task_id])], evaluator: allPass })
  const t = Object.fromEntries(r.scorecards[0].tasks.map(x => [x.task_id, [x.status, x.reason]]))
  assert.deepEqual(t['toronto-agency-office'], ['failed', 'malformed adapter result: cost_usd "0.5" is not a non-negative number or null'])
  assert.deepEqual(t['london-seed-saas'], ['failed', 'malformed adapter result: items is not a list'])
  assert.deepEqual(t['munich-maschinenbau'], ['failed', 'malformed adapter result: interventions -1 is not a non-negative integer'])
  assert.match(String(t['negative-reykjavik-ipo'][1]), /stopped "bored" is not one of budget/)
  assert.equal(r.spent_usd, 8)                       // 4 tasks x the $2 limit: an unreadable cost is never 0 and never a string
  assert.equal(typeof r.spent_usd, 'number')
  for (const v of [null, 7, 'x', [], true]) {        // not an object at all
    const x = await runBatch({ ...base(), adapters: [stub('alpha', async () => v)], evaluator: allPass })
    assert.ok(x.scorecards[0].tasks.every(k => k.status === 'failed' && /malformed adapter result: the result is not an object|items is not a list/.test(k.reason!)), JSON.stringify(v))
  }
})

test('untrusted output rows: not an object, no company or a wrong-typed field are dropped or nulled and counted, never a crash; a huge output is capped', async () => {
  const rows: unknown[] = [null, 5, 'Acme', { company: 7 }, { company: '   ' }, { company: 'Acme', domain: 42, contact: ['x'], event_date: 20261001, evidence_urls: 'https://a.example', quotes: 'q', person: 'Pat' }]
  for (let i = 0; i < 60; i++) rows.push({ company: `Co ${i}`, domain: `co${i}.example` })
  const seen: BlindItem[] = []
  const r = await runBatch({ ...base(), adapters: [stub('alpha', async b => ({ items: b.task_id === 'toronto-agency-office' ? rows : [], cost_usd: 0.1, seconds: 1, interventions: 0 }))], evaluator: { ...allPass, judge: async (items, b) => { seen.push(...items); return allPass.judge(items, b) } } })
  const task = r.scorecards[0].tasks.find(t => t.task_id === 'toronto-agency-office')!
  assert.equal(task.status, 'complete'); assert.equal(task.returned, 50)
  assert.match(task.reason!, /^16 malformed or excess output row\(s\) dropped, not scored$/)   // 5 malformed + 11 past the cap of 50 (61 good rows)
  const acme = seen.find(i => i.company === 'Acme')!
  assert.deepEqual([acme.domain, acme.contact, acme.event_date, acme.evidence_urls, acme.quotes, acme.person], [null, null, null, [], [], null])
})

test('an available system that started no task is not_started with the reason, never a ran system with zero results', async () => {
  const none = await runBatch({ ...base(), adapters: [stub('alpha', async () => ({ items: [], cost_usd: 0, seconds: 0, interventions: 0 }), () => 'the product has no Munich data')], evaluator: allPass })
  assert.deepEqual([none.report[0].status, none.report[0].attempted, none.report[0].precision_at_10], ['not_started', 0, null])
  assert.match(none.report[0].reason!, /^no task started: 4 unsupported \(the system cannot express this task: the product has no Munich data\)$/)
  const broke = await runBatch({ ...base(), budget: { usd_per_task: 2, seconds_per_task: 30, batch_usd: 0 }, adapters: [stub('alpha', async () => ({ items: [], cost_usd: 0, seconds: 0, interventions: 0 }))], evaluator: allPass })
  assert.equal(broke.report[0].status, 'not_started'); assert.match(broke.report[0].reason!, /4 not_run \(batch budget reached/)
  // a failed attempt still ran: its spend is shown, it is not hidden as not started
  const failed = await runBatch({ ...base(), adapters: [stub('alpha', async () => { throw new Error('500') })], evaluator: allPass })
  assert.deepEqual([failed.report[0].status, failed.report[0].attempted, failed.report[0].reason], ['ran', 4, null])
})

test('the evaluator receives the provenance the verifier re-reads, and a quote, person or source url naming a system is withheld, never rewritten', async () => {
  const seen: BlindItem[] = []
  const item = { company: 'Querix', domain: 'querix.example', event_date: '2026-10-08', event_source_url: 'https://news.example/q', evidence_urls: ['https://news.example/q'],
    quotes: [{ text: 'Querix opened a Toronto office', source_url: 'https://news.example/q' }, { text: 'Alpha found Querix first', source_url: 'https://news.example/q' }],
    person: { name: 'Pat Example', title: 'Founder', source_url: 'https://querix.example/team' }, contact: 'pat@querix.example', contact_source_url: 'https://querix.example/team' }
  const x = stub('alpha', async b => ({ items: b.task_id === 'toronto-agency-office' ? [item, { ...item, company: 'Isar', domain: 'isar.example', person: { name: 'Pat Example', title: 'Alpha partner', source_url: 'https://isar.example/team' }, contact_source_url: 'https://alpha.example/lead' }] : [], cost_usd: 0.1, seconds: 1, interventions: 0 }))
  await runBatch({ ...base(), adapters: [x], evaluator: { ...allPass, judge: async (items, b) => { seen.push(...items); return allPass.judge(items, b) } } })
  const q = seen.find(i => i.company === 'Querix')!, isar = seen.find(i => i.company === 'Isar')!
  assert.deepEqual([q.event_source_url, q.quotes, q.person, q.contact_source_url], ['https://news.example/q', [item.quotes[0]], item.person, 'https://querix.example/team'])
  assert.deepEqual([isar.person, isar.contact_source_url], [null, null])
})
