// Agent evals (docs/design/agent-evals.md): trace -> World -> case -> replay -> deterministic evaluators -> baseline gate.
// Every World here is SYNTHETIC (invented companies, pages and addresses); nothing replays a real run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, cpSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { TraceRecorder, totals, type Trace } from '../lib/evals/trace.ts'
import { worldFromTrace, validateWorld, WorldError, type World } from '../lib/evals/world.ts'
import { redactTrace } from '../lib/evals/redact.ts'
import { loadCase, validateCase, CaseError, type Case } from '../lib/evals/case.ts'
import { replayCase } from './helpers/eval-replay.ts'
import { CANARY, CANARY_TENANT, type ReplayResult } from '../lib/evals/result.ts'
import { scoreCase, eventDateInWindow, evidenceInWorld, contactDomainMatchesCompany, noTenantLeak, placeOnPage, worldClosed, expectedOutcomes, type EvalContext, type Evaluator } from '../lib/evals/evaluators.ts'
import { runSuite, loadBaseline, compareBaseline, gate, type SuiteRow } from './helpers/eval-suite.ts'
import type { Provider } from '../lib/llm/provider.ts'

const DIR = new URL('./fixtures/evals/', import.meta.url).pathname
const CASE_FILE = `${DIR}cases/scan-london-seed-traps.case.json`
const TRACE = JSON.parse(readFileSync(`${DIR}traces/scan-london-seed-traps.trace.json`, 'utf8')) as Trace
const clone = <T>(x: T): T => structuredClone(x)
const statuses = (e: Evaluator, ctx: EvalContext) => Object.fromEntries(e.evaluate(ctx).map(v => [v.subject, v.status]))

let cached: { kase: Case; world: World; result: ReplayResult } | null = null
async function base() {
  if (!cached) { const { kase, world } = loadCase(CASE_FILE); cached = { kase, world, result: await replayCase(kase, world) } }
  return clone(cached)
}

test('the committed World is exactly what worldFromTrace derives from the committed synthetic trace', () => {
  const { world } = loadCase(CASE_FILE)
  assert.deepEqual(worldFromTrace(TRACE, world.id), world)
  assert.equal(world.origin, 'synthetic')
})

test('replay runs the real scan offline against the World: closed, deterministic, and the agent gap is visible', async () => {
  const { kase, world, result } = await base()
  assert.equal(result.outcome, 'done')
  assert.deepEqual(result.misses, [])
  const got = Object.fromEntries(result.leads.map(l => [l.company, l.review_reason]))
  assert.deepEqual(got, { 'Querix': null, 'Northwind Analytics': 'event_date_stale', 'Orbit Labs': 'event_date_future_date', 'Lumen Ledger': null })
  // Lumen Ledger (Paris page, London request) verifying is the agent gap the baseline records, caught by two evaluators.
  const s = scoreCase({ kase, world, result })
  assert.equal(s.status, 'fail')
  assert.deepEqual(s.verdicts.filter(v => v.status !== 'pass').map(v => `${v.evaluator}|${v.subject}|${v.status}`).sort(), ['expected_outcomes|expect:Lumen Ledger|fail', 'place_on_page|lead:Lumen Ledger|unknown'])
  const again = await replayCase(kase, world)
  assert.deepEqual(again.leads, result.leads)
  assert.deepEqual(scoreCase({ kase, world, result: again }).verdicts, s.verdicts)
})

test('a replay trace freezes back into the same World (search, pages, model replies)', async () => {
  const { world, result } = await base()
  const w2 = worldFromTrace(result.trace, world.id)
  for (const k of ['tinyfish_pages', 'pages', 'model'] as const) assert.deepEqual(w2[k], world[k], k)
  // every query the World answered is answered the same; the extra ones are the people searches a synthetic World answers with no profiles
  for (const [q, hits] of Object.entries(world.search.by_query)) assert.deepEqual(w2.search.by_query[q], hits)
  for (const [q, hits] of Object.entries(w2.search.by_query)) if (!(q in world.search.by_query)) { assert.match(q, /^site:linkedin\.com\/in /); assert.deepEqual(hits, []) }
  // the synthetic default became explicit per-URL answers, each the default
  assert.ok(Object.keys(w2.http).length > 0)
  for (const r of Object.values(w2.http)) assert.deepEqual(r, world.http_default)
  const t = totals(result.trace)
  assert.equal(t.model_calls, 2); assert.equal(t.page_fetches, 5); assert.equal(t.cost_usd, null) // stub model has no listed price: unknown, not $0
})

test('the suite matches the committed baseline exactly, and a verdict change in either direction is reported', async () => {
  const rows = await runSuite(`${DIR}cases`)
  const b = loadBaseline(`${DIR}baseline.json`)
  // registered, with the two known Paris-for-London failures this case found (fixed in the place-agreement PR)
  const KNOWN = ['expected_outcomes|expect:Lumen Ledger|fail', 'place_on_page|lead:Lumen Ledger|unknown']
  assert.deepEqual(b.cases['scan-london-seed-traps'].non_pass, KNOWN)
  assert.deepEqual(compareBaseline(rows, b), [{ case: 'scan-london-seed-traps', regressions: [], fixed: [] }])
  assert.equal(gate(rows, b).ok, true)
  const stale = { ...b, cases: { 'scan-london-seed-traps': { status: 'fail', non_pass: [...KNOWN, 'event_date_in_window|lead:Querix|fail'] } } }
  assert.deepEqual(compareBaseline(rows, stale)[0].fixed, ['event_date_in_window|lead:Querix|fail'])  // a fixed entry left in the baseline fails the gate
  assert.equal(gate(rows, stale).ok, false)
  const regressed = rows.map(r => ({ ...r, nonPass: [...r.nonPass, 'event_date_in_window|lead:Querix|fail'] }))
  assert.deepEqual(compareBaseline(regressed, b)[0], { case: 'scan-london-seed-traps', regressions: ['event_date_in_window|lead:Querix|fail'], fixed: [] })
  assert.equal(gate(regressed, b).ok, false)
  const unlisted = { ...b, cases: { 'scan-london-seed-traps': { status: 'pass', non_pass: [] } } }
  assert.deepEqual(compareBaseline(rows, unlisted)[0].regressions, KNOWN)                       // known failures must be listed, not dropped
  assert.equal(gate(rows, unlisted).ok, false)
})

test('gate: the case set itself is checked - a missing, unregistered or duplicate case, or too few cases, is red', async () => {
  const rows = await runSuite(`${DIR}cases`)
  const b = loadBaseline(`${DIR}baseline.json`)
  const row = (id: string): SuiteRow => ({ ...rows[0], case: id })
  const missing = gate([], b)
  assert.equal(missing.ok, false); assert.deepEqual(missing.missing, ['scan-london-seed-traps']); assert.equal(missing.ran, 0)
  assert.deepEqual(compareBaseline([], b), [{ case: 'scan-london-seed-traps', regressions: ['case_did_not_run'], fixed: [] }]) // the comparison alone is never empty for a missing case
  const two = { ...b, min_cases: 2, cases: { ...b.cases, 'other-case': { status: 'pass', non_pass: [] } } }
  const dropped = gate(rows, two)                                     // one of two registered cases deleted
  assert.equal(dropped.ok, false); assert.deepEqual(dropped.missing, ['other-case'])
  const floor = gate(rows, { ...b, min_cases: 2 })                    // entry removed too, but the floor was not lowered
  assert.equal(floor.ok, false); assert.deepEqual(floor.missing, []); assert.equal(floor.ran, 1); assert.equal(floor.minCases, 2)
  const extra = gate([...rows, row('new-case')], b)                    // a case that runs without being registered
  assert.equal(extra.ok, false); assert.deepEqual(extra.unregistered, ['new-case'])
  const dup = gate([...rows, row('scan-london-seed-traps')], { ...b, min_cases: 1 })
  assert.equal(dup.ok, false); assert.deepEqual(dup.duplicates, ['scan-london-seed-traps'])
  assert.throws(() => { const f = join(mkdtempSync(join(tmpdir(), 'dazl-baseline-')), 'b.json'); writeFileSync(f, JSON.stringify({ ...b, min_cases: 0 })); loadBaseline(f) }, /min_cases/)
})

const runCli = (dir: string) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', 'scripts/evals.mts', '--dir', dir],
  { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { ...process.env, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0' } })
// A temp copy of the committed suite, optionally with a second registered case (a copy of the London case under another id).
function suiteCopy(opts: { second?: boolean } = {}): string {
  const tmp = mkdtempSync(join(tmpdir(), 'dazl-evals-'))
  cpSync(DIR, tmp, { recursive: true })
  if (opts.second) {
    const c = JSON.parse(readFileSync(join(tmp, 'cases', 'scan-london-seed-traps.case.json'), 'utf8'))
    writeFileSync(join(tmp, 'cases', 'scan-london-seed-traps-copy.case.json'), JSON.stringify({ ...c, id: 'scan-london-seed-traps-copy' }))
    const b = JSON.parse(readFileSync(join(tmp, 'baseline.json'), 'utf8'))
    writeFileSync(join(tmp, 'baseline.json'), JSON.stringify({ ...b, min_cases: b.min_cases + 1, cases: { ...b.cases, 'scan-london-seed-traps-copy': b.cases['scan-london-seed-traps'] } }))
  }
  return tmp
}
const gateRed = (r: ReturnType<typeof runCli>, ...lines: RegExp[]) => {
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /eval gate: FAIL/)
  for (const l of lines) assert.match(r.stdout, l)
}

test('gate CLI: deleting or renaming the only case turns `npm run evals` red (exit 1, the case named)', () => {
  for (const how of ['delete', 'rename'] as const) {
    const tmp = suiteCopy()
    try {
      const intact = runCli(tmp)
      assert.equal(intact.status, 0, intact.stdout + intact.stderr); assert.match(intact.stdout, /eval gate: ok/)
      const f = join(tmp, 'cases', 'scan-london-seed-traps.case.json')
      if (how === 'delete') unlinkSync(f); else renameSync(f, `${f}.bak`)
      gateRed(runCli(tmp), /MISSING CASE \(registered in baseline.json, did not run\): scan-london-seed-traps/, /TOO FEW CASES: 0 ran, baseline min_cases is 1/)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  }
})

test('gate CLI: deleting one of several cases, or renaming its id, is red; an empty suite directory is red', () => {
  const tmp = suiteCopy({ second: true })
  try {
    const intact = runCli(tmp)
    assert.equal(intact.status, 0, intact.stdout + intact.stderr)
    assert.match(intact.stdout, /2 of 2\+ registered cases ran/)
    const copy = join(tmp, 'cases', 'scan-london-seed-traps-copy.case.json')
    const saved = readFileSync(copy, 'utf8')
    unlinkSync(copy)
    gateRed(runCli(tmp), /MISSING CASE \(registered in baseline.json, did not run\): scan-london-seed-traps-copy/, /TOO FEW CASES: 1 ran, baseline min_cases is 2/)
    writeFileSync(copy, JSON.stringify({ ...JSON.parse(saved), id: 'renamed-case' }))  // same file, new id: the old id is missing, the new one unregistered
    gateRed(runCli(tmp), /MISSING CASE .*: scan-london-seed-traps-copy/, /UNREGISTERED CASE \(add to baseline.json\): renamed-case/)
    writeFileSync(copy, JSON.stringify({ ...JSON.parse(saved), id: 'scan-london-seed-traps' })) // two files, one id
    gateRed(runCli(tmp), /DUPLICATE CASE ID: scan-london-seed-traps/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
  const empty = mkdtempSync(join(tmpdir(), 'dazl-evals-empty-'))
  try {
    const r = runCli(empty)                                       // no cases/ and no baseline.json: the run cannot pass
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /eval gate: ok/)
  } finally { rmSync(empty, { recursive: true, force: true }) }
})

test('world_closed: a page the World does not have is a recorded miss, answered as a failed fetch, never fetched', async () => {
  const { kase, world } = await base()
  delete world.pages['https://news.example/london/querix-seed']
  const r = await replayCase(kase, world)
  assert.deepEqual(r.misses, [{ kind: 'page', key: 'https://news.example/london/querix-seed' }])
  assert.equal(statuses(worldClosed, { kase, world, result: r }).run, 'fail')
  assert.equal(r.leads.find(l => l.company === 'Querix')?.review_reason ?? 'absent', 'absent') // the verifier saw an error page, so Querix is not verified
  // a model stage the World cannot answer is a miss too (and the scan fails rather than inventing a reply)
  const w2 = clone(world); w2.model.extraction = []
  const r2 = await replayCase(kase, w2)
  assert.ok(r2.misses.some(m => m.kind === 'model' && m.key === 'extraction#0'))
  assert.equal(r2.leads.length, 0)
})

test('event_date_in_window: impossible, future, out-of-window and missing dates never pass', async () => {
  const ctx = await base()
  const q = ctx.result.leads.find(l => l.company === 'Querix')!
  const at = (d: string | null) => { const c = clone(ctx); c.result.leads = [{ ...q, event_date: d }]; return statuses(eventDateInWindow, c)['lead:Querix'] }
  assert.equal(at('2026-10-10'), 'pass')
  assert.equal(at('2026-02-30'), 'fail')
  assert.equal(at('2026-13-01'), 'fail')
  assert.equal(at('10/10/2026'), 'fail')
  assert.equal(at('2026-11-30'), 'fail')
  // calendar days against the as_of DAY, whatever its time: today passes, tomorrow fails, the window edge is inclusive
  const atAsOf = (asOf: string, date: string) => { const c = clone(ctx); c.world.as_of = asOf; c.result.leads = [{ ...q, event_date: date }]; return statuses(eventDateInWindow, c)['lead:Querix'] }
  for (const asOf of ['2026-10-29T00:00:00Z', '2026-10-29T20:00:00Z', '2026-10-29T23:59:59.999Z']) {
    assert.equal(atAsOf(asOf, '2026-10-29'), 'pass', `today at ${asOf}`)
    assert.equal(atAsOf(asOf, '2026-10-30'), 'fail', `tomorrow at ${asOf}`)
    assert.equal(atAsOf(asOf, '2026-07-31'), 'pass', `exactly 90 days before at ${asOf}`)
    assert.equal(atAsOf(asOf, '2026-07-30'), 'fail', `91 days before at ${asOf}`)
    assert.equal(atAsOf(asOf, '2026-02-29'), 'fail', `impossible date at ${asOf}`)
  }
  // Instinct's direct fixture: an empty profile and expectations, a lead dated the day after as_of
  const direct = eventDateInWindow.evaluate({ kase: { ...clone(ctx.kase), input: { ...ctx.kase.input, icp: {} }, expect: {} as never }, world: { ...clone(ctx.world), as_of: '2026-10-29T00:00:00Z' },
    result: { ...clone(ctx.result), leads: [{ ...q, company: 'Synthetic Buyer', event_date: '2026-10-30', source_url: 'https://fixture.invalid/source', review_reason: null }] } })
  assert.deepEqual(direct.map(x => x.status), ['fail'])
  assert.equal(at('2026-01-02'), 'fail')   // 291 days before as_of, window 90
  assert.equal(at(null), 'unknown')
  // held leads are not judged here (they are not claimed as verified)
  const c = clone(ctx); c.result.leads = [{ ...q, event_date: '2026-02-30', review_reason: 'quote_unconfirmed' }]
  assert.deepEqual(eventDateInWindow.evaluate(c), [])
})

test('evidence_in_world: a quote that is not on the frozen page, a URL the World never served, or no quote at all fails', async () => {
  const ctx = await base()
  const q = ctx.result.leads.find(l => l.company === 'Querix')!
  const at = (patch: Partial<typeof q>) => { const c = clone(ctx); c.result.leads = [{ ...q, ...patch }]; return statuses(evidenceInWorld, c)['lead:Querix'] }
  assert.equal(at({}), 'pass')
  assert.equal(at({ excerpt: 'Querix closed a 50m GBP Series C' }), 'fail')
  assert.equal(at({ source_url: 'https://elsewhere.example/q' }), 'fail')
  assert.equal(at({ excerpt: null }), 'fail')
})

test('place_on_page: the requested city on the page passes; a page without it is unknown, never pass', async () => {
  const ctx = await base()
  const s = statuses(placeOnPage, ctx)
  assert.equal(s['lead:Querix'], 'pass')
  assert.equal(s['lead:Lumen Ledger'], 'unknown')
  const c = clone(ctx); (c.kase.input.icp as { where: string[] }).where = []
  assert.deepEqual(placeOnPage.evaluate(c), [])
  // "Londonderry" is not London
  const d = clone(ctx); d.world.pages['https://news.example/london/querix-seed'] = { title: 'Querix', text: 'Querix opened in Londonderry.' }
  delete d.world.tinyfish_pages['https://news.example/london/querix-seed']
  assert.equal(statuses(placeOnPage, d)['lead:Querix'], 'unknown')
})

test('contact_domain_matches_company: a contact at another domain fails; phone-only or no ground truth is unknown', async () => {
  const ctx = await base()
  const q = ctx.result.leads.find(l => l.company === 'Querix')!
  const at = (contact: string, c0 = ctx) => { const c = clone(c0); c.result.leads = [{ ...q, contact }]; return statuses(contactDomainMatchesCompany, c)['lead:Querix'] }
  assert.equal(at('hello@querix.example'), 'pass')
  assert.equal(at('sales@eu.querix.example'), 'pass')         // subdomain of the company's domain
  assert.equal(at('querix.founder@gmail.com'), 'fail')
  assert.equal(at('hello@querix-example.com'), 'fail')        // lookalike domain
  assert.equal(at('+44 20 7946 0000'), 'unknown')
  const noTruth = clone(ctx); delete noTruth.kase.expect.entities
  assert.equal(at('hello@querix.example', noTruth), 'unknown')
})

test('no_tenant_leak: canary data in a prompt, a lead or a changed canary row fails', async () => {
  const ctx = await base()
  assert.equal(statuses(noTenantLeak, ctx).run, 'pass')
  const inPrompt = clone(ctx); (inPrompt.result.trace.spans[0].input as { prompt: string }).prompt += ` also see ${CANARY.contact}`
  assert.equal(statuses(noTenantLeak, inPrompt).run, 'fail')
  const foreign = clone(ctx); foreign.result.leads.push({ ...foreign.result.leads[0], company: CANARY.company, tenant: CANARY_TENANT })
  assert.equal(statuses(noTenantLeak, foreign).run, 'fail')
  const touched = clone(ctx); touched.result.canaryIntact = false
  assert.equal(statuses(noTenantLeak, touched).run, 'fail')
})

test('expected_outcomes: wrong outcome, wrong hold reason and an unexpected verified lead each fail', async () => {
  const ctx = await base()
  const c = clone(ctx)
  c.kase.expect.leads = [{ company: 'Querix', outcome: 'held' }, { company: 'Orbit Labs', outcome: 'held', review_reason: 'event_date_stale' }]
  const s = statuses(expectedOutcomes, c)
  assert.equal(s['expect:Querix'], 'fail')
  assert.equal(s['expect:Orbit Labs'], 'fail')
  assert.equal(s['lead:Lumen Ledger'], 'fail')              // exhaustive: verified but not named
})

test('scoreCase: unknown is never pass, and unknowns stay in the validated-rate denominator', async () => {
  const ctx = await base()
  const c = clone(ctx); c.kase.expect.leads = [{ company: 'Lumen Ledger', outcome: 'verified' }]; c.kase.expect.exhaustive = false
  const s = scoreCase(c, [placeOnPage, expectedOutcomes])
  assert.equal(s.status, 'unknown')
  assert.equal(s.validated_rate, 2 / 3)                     // Querix place pass + expectation pass, of 3 verdicts
  assert.equal(s.unknown_rate, 1 / 3)
})

test('trace recorder: never records the API key or request headers; results and throws pass through unchanged', async () => {
  const rec = new TraceRecorder(() => 0)
  const p = rec.provider({ research: async () => ({ text: 'r', citedUrls: [] }), complete: async () => 'ok', completeDetailed: async () => { throw new Error('boom') } } as Provider, 'anthropic')
  assert.equal(await p.complete!('sk-ant-SECRETSECRET', 'Write up to 6 web search queries for x', undefined, 300), 'ok')
  await assert.rejects(p.completeDetailed!('sk-ant-SECRETSECRET', 'You turn pre-collected public items into leads'), /boom/)
  const f = rec.fetch((async () => new Response('{"results":[]}', { status: 200 })) as typeof fetch)
  const res = await f('https://api.search.tinyfish.ai/?query=x', { headers: { 'X-API-Key': 'tf-SECRETSECRET' } })
  assert.equal(await res.text(), '{"results":[]}')           // the caller still gets an unread body
  const all = JSON.stringify(rec.spans)
  assert.ok(!all.includes('SECRETSECRET'))
  assert.deepEqual(rec.spans.map(s => [s.name, (s.input as { stage?: string }).stage ?? null, s.error ?? null]), [['anthropic.complete', 'search_queries', null], ['anthropic.completeDetailed', 'extraction', 'boom'], ['tinyfish.search', null, null]])
})

test('worlds fail closed: a real trace must be redacted, and a recorded world answers only what it saw', () => {
  const real = { ...clone(TRACE), synthetic: false, synthetic_defaults: undefined }
  assert.throws(() => worldFromTrace(real), WorldError)
  assert.throws(() => worldFromTrace({ ...clone(TRACE), synthetic: false }), /synthetic_defaults/)
  const w = worldFromTrace(redactTrace(real, Buffer.alloc(16)))
  assert.equal(w.origin, 'recorded'); assert.equal(w.redacted, true)
  assert.throws(() => validateWorld({ ...w, redacted: false }), /must be redacted/)
  assert.throws(() => validateWorld({ ...w, http_default: { status: 404, body: '' } }), /only the calls it saw/)
  assert.throws(() => validateWorld({ ...w, v: 2 }), /unsupported version/)
  assert.throws(() => validateCase({ ...JSON.parse(readFileSync(CASE_FILE, 'utf8')), expect: { leads: [] } }), CaseError)
})

test('redaction: emails, phones, LinkedIn slugs and extracted person names are replaced consistently; dates survive; the replay still verifies', async () => {
  const t = clone(TRACE)
  const page = t.spans.find(s => s.kind === 'page' && (s.input as { url: string }).url.endsWith('querix-seed'))!
  ;(page.output as { text: string }).text += ' Call +44 20 7946 0958 or see linkedin.com/in/jane-doe-123. Updated 2026-10-10 12:30.'
  const r = redactTrace({ ...t, synthetic: false, synthetic_defaults: undefined }, Buffer.alloc(16, 7))
  const all = JSON.stringify(r)
  for (const pii of ['hello@querix.example', '7946 0958', 'jane-doe-123', 'Dana Example']) assert.ok(!all.includes(pii), pii)
  assert.ok(all.includes('@querix.example'))                  // the company domain is kept (a documented gap, not anonymisation)
  // object keys are redacted too (a World keys pages by URL)
  const keyed = redactTrace({ ...t, synthetic: false, synthetic_defaults: undefined, spans: [{ ...t.spans[0], output: { 'https://x.example/u/hello@querix.example': 1, 'linkedin.com/in/jane-doe-123': 2 } }] }, Buffer.alloc(16, 7))
  const keys = Object.keys(keyed.spans[0].output as object).join(' ')
  assert.ok(!keys.includes('hello@querix.example') && !keys.includes('jane-doe-123'), keys)
  assert.ok(all.includes('2026-10-10') && all.includes('2026-11-15') && all.includes('Updated 2026-10-10 12:30.')) // a date then a time is not a phone
  const tokens = all.match(/p[0-9a-f]{10}@querix\.example/g) ?? []
  assert.ok(tokens.length >= 2 && new Set(tokens).size === 1) // the same token in the page and in the model's reply
  // a redacted World replays to the same outcomes (as a synthetic stand-in: the shape is what is under test)
  const { kase } = loadCase(CASE_FILE)
  const w = { ...worldFromTrace(r), origin: 'synthetic' as const, http_default: { status: 404, body: '' } }
  const res = await replayCase(kase, w)
  const q = res.leads.find(l => l.company === 'Querix')!
  assert.equal(q.review_reason, null)
  assert.match(q.contact ?? '', /^p[0-9a-f]{10}@querix\.example$/)
  assert.equal(statuses(contactDomainMatchesCompany, { kase, world: w, result: res })['lead:Querix'], 'pass')
})
