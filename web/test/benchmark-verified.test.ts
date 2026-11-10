// The benchmark's independent evaluator (lib/benchmark/verified-evaluator.ts) and recorded batches (lib/benchmark/
// recorded.ts), #397 (#786/#787/#788). SYNTHETIC pages, companies and outputs only: no network, no model, no account,
// no spend. Every snapshot below is a fixture handed to the verifier, never fetched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchFromFile, runBatch, type BatchFile, type BlindItem, type Brief, type Judgement } from '../lib/benchmark/runner.ts'
import { parseSnapshots, placeOf, verifierEvaluator, SNAPSHOT_LIMITS } from '../lib/benchmark/verified-evaluator.ts'
import { authorizationProblem, checkRecording, checkRegistry, dazlRecordingFromScoreboard, recordedBatch, recordingSha, RECORDING_FORMAT } from '../lib/benchmark/recorded.ts'
import type { TaskSet } from '../lib/benchmark/scorecard.ts'
import { CONTRACT_VERSION, scorecardVerdicts } from '../lib/evals/contract.ts'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(WEB, '..')
const FIXTURE = path.join(WEB, 'test', 'fixtures', 'benchmark', 'synthetic-verified-batch.json')
const V1 = JSON.parse(readFileSync(path.join(ROOT, 'scoreboard', 'benchmark', 'v1', 'tasks.json'), 'utf8')) as TaskSet
const REGISTRY = JSON.parse(readFileSync(path.join(ROOT, 'scoreboard', 'benchmark', 'adapters.json'), 'utf8')) as unknown

type Snap = { url: string; text?: string; html?: string; outcome?: string; meta_days?: string[]; truncated?: boolean; final_url?: string | null }
const snaps = (list: Snap[], over: Record<string, unknown> = {}) => parseSnapshots({ format: 'dazl-verifier-snapshots', version: 1, captured_by: 'dazl-verifier (test)', captured_at: '2026-10-20T12:00:00Z', snapshots: list.map(s => ({ outcome: 'ok', final_url: null, truncated: false, meta_days: [], linked_domains: [], ...s })), ...over })
const brief = (constraints: unknown, window_days: number | null = 90): Brief => ({ task_id: 't1', query: 'q', seller: null, language: 'en', constraints, as_of: '2026-10-20', window_days })
const TORONTO = { all_of: [{ geo: 'Toronto, CA' }, { event: 'office_opening', within_days: 90 }] }
const item = (over: Partial<BlindItem> = {}): BlindItem => ({
  unchecked: [], blind_id: 'b1', company: 'Maple Leaf Marketing', domain: 'mapleleaf.example', contact: 'hello@mapleleaf.example', event_date: '2026-10-08', text: null,
  evidence_urls: ['https://news.example/maple', 'https://mapleleaf.example/news'], event_source_url: 'https://news.example/maple', quotes: [], person: null,
  contact_source_url: 'https://mapleleaf.example/contact', ...over,
})
const PAGES: Snap[] = [
  { url: 'https://news.example/maple', text: 'Maple Leaf Marketing opened a new office in Toronto, Canada on October 8, 2026. The agency is at mapleleaf.example.' },
  { url: 'https://mapleleaf.example/news', text: 'On October 8, 2026 Maple Leaf Marketing opened its new Toronto studio.' },
  { url: 'https://mapleleaf.example/contact', text: 'Contact Maple Leaf Marketing at hello@mapleleaf.example.' },
]
const judge = async (it: BlindItem, b: Brief, pages: Snap[] = PAGES, min?: number): Promise<Judgement & { record: Record<string, unknown> }> =>
  (await verifierEvaluator({ snapshots: snaps(pages), min_independent_origins: min }).judge([it], b))[it.blind_id] as Judgement & { record: Record<string, unknown> }
const fields = (j: Judgement) => [j.identity, j.constraints, j.event_date, j.contact]

// ---------------------------------------------------------------------------------------------------- the evaluator

test('#397: validated means independently corroborated: two origins state the dated event; one source, a same-domain page or a syndicated copy is not enough', async () => {
  assert.deepEqual(fields(await judge(item(), brief(TORONTO))), ['pass', 'pass', 'pass', 'pass'])
  const one = await judge(item({ evidence_urls: ['https://news.example/maple'] }), brief(TORONTO))
  assert.deepEqual(fields(one), ['pass', 'unknown', 'unknown', 'pass'])   // the opening is stated on one origin too
  assert.equal(one.record.independent_origins, 1); assert.equal(one.record.signal_tier, 'source-checked')
  const lone = await judge(item({ evidence_urls: ['https://news.example/maple'] }), brief(TORONTO), PAGES, 1)   // a batch that asks for one origin
  assert.deepEqual(fields(lone), ['pass', 'pass', 'pass', 'pass']); assert.equal(lone.record.signal_tier, 'source-checked')   // passing at 1 is never called corroborated
  // a second page on the same registrable domain is the same origin
  const same = await judge(item({ evidence_urls: ['https://news.example/maple', 'https://www.news.example/maple-2'] }), brief(TORONTO), [...PAGES, { url: 'https://www.news.example/maple-2', text: 'On October 8, 2026 Maple Leaf Marketing opened its Toronto office, at mapleleaf.example.' }])
  assert.equal(same.record.independent_origins, 1); assert.equal(same.event_date, 'unknown')
  // a syndicated copy: the same event sentence on another domain
  const synd = await judge(item({ evidence_urls: ['https://news.example/maple', 'https://wire.example/maple'] }), brief(TORONTO), [...PAGES, { url: 'https://wire.example/maple', text: PAGES[0].text }])
  assert.equal(synd.record.independent_origins, 1); assert.equal(synd.event_date, 'unknown')
  // a copy that says rel=canonical to the original, reworded
  const canon = await judge(item({ evidence_urls: ['https://news.example/maple', 'https://agg.example/x'] }), brief(TORONTO), [...PAGES, { url: 'https://agg.example/x', html: '<html><head><link rel="canonical" href="https://news.example/maple"></head><body><p>Agency news: on October 8, 2026 Maple Leaf Marketing opened a Toronto office.</p></body></html>' }])
  assert.equal(canon.record.independent_origins, 1); assert.equal(canon.event_date, 'unknown')
  // a cited page that does not state the event does not corroborate it
  const unrelated = await judge(item({ evidence_urls: ['https://news.example/maple', 'https://other.example/x'] }), brief(TORONTO), [...PAGES, { url: 'https://other.example/x', text: 'Maple Leaf Marketing is a Toronto agency.' }])
  assert.equal(unrelated.record.independent_origins, 1)
})

test('#397: a firmographic guess is never validated: no dated event, or an event only in the producer\'s own text, is unknown on every field it cannot show', async () => {
  const guess = await judge(item({ company: 'Harbour Studio', domain: 'harbourstudio.example', event_date: null, evidence_urls: [], event_source_url: null, text: 'Opened a Toronto office on October 8, 2026 (verified).', contact: null, contact_source_url: null }), brief(TORONTO))
  assert.deepEqual(fields(guess), ['unknown', 'unknown', 'unknown', 'unknown'])
  // the producer cites pages the verifier never captured: its claim is not read from its own text
  const unread = await judge(item({ evidence_urls: ['https://elsewhere.example/a', 'https://elsewhere2.example/b'], event_source_url: null }), brief(TORONTO))
  assert.deepEqual(fields(unread).slice(0, 3), ['unknown', 'unknown', 'unknown'])
})

test('#397: the place comes from the brief: a wrong city fails, a same-name city in another country is unknown, a country-only brief uses its names', async () => {
  const wrong = [{ url: 'https://news.example/maple', text: 'Maple Leaf Marketing opened a new office in Montreal, Canada on October 8, 2026 (mapleleaf.example).' }, { url: 'https://mapleleaf.example/news', text: 'On October 8, 2026 Maple Leaf Marketing opened its new Montreal studio.' }, PAGES[2]]
  assert.equal((await judge(item(), brief(TORONTO), wrong)).constraints, 'fail')
  const LONDON = { all_of: [{ geo: 'London, GB' }, { event: 'office_opening' }] }
  const ontario = [{ url: 'https://news.example/maple', text: 'Maple Leaf Marketing opened a new office in London, Ontario, Canada on October 8, 2026 (mapleleaf.example).' }, { url: 'https://mapleleaf.example/news', text: 'On October 8, 2026 Maple Leaf Marketing opened its London studio.' }, PAGES[2]]
  assert.equal((await judge(item(), brief(LONDON), ontario)).constraints, 'unknown')
  assert.deepEqual(placeOf('US'), { cities: ['United States', 'USA', 'U.S.', 'America'], countries: null, problem: null, geo: 'US' })
  assert.deepEqual(placeOf('Munich region, DE').cities, ['Munich', 'München'])
  assert.match(placeOf('Oslo, NO').problem!, /country code NO has no country-name table/)   // never matched as the word "no"
  const oslo = await judge(item(), brief({ all_of: [{ geo: 'Oslo, NO' }, { event: 'office_opening' }] }))
  assert.equal(oslo.constraints, 'unknown')
})

test('#397: constraints are shown, never assumed: the event kind and its roles/round are worded in the dated sentence; hedged wording, segment, headcount and exclusions are unknown', async () => {
  const FUND = { all_of: [{ geo: 'Toronto, CA' }, { event: 'funding', stage: 'seed' }] }
  assert.equal((await judge(item(), brief(FUND))).constraints, 'unknown')            // the pages say "opened", not a seed round
  const hedged = [{ url: 'https://news.example/maple', text: 'Maple Leaf Marketing reportedly opened a new office in Toronto, Canada on October 8, 2026 (mapleleaf.example).' }, { url: 'https://mapleleaf.example/news', text: 'Maple Leaf Marketing did not open a Toronto studio on October 8, 2026.' }, PAGES[2]]
  assert.equal((await judge(item(), brief(TORONTO), hedged)).constraints, 'unknown')
  const HIRE = { all_of: [{ geo: 'Toronto, CA' }, { event: 'job_posting', roles: ['office manager'] }] }
  const hiring = [{ url: 'https://news.example/maple', text: 'Maple Leaf Marketing (mapleleaf.example) in Toronto, Canada is hiring an office manager as of October 8, 2026.' }, { url: 'https://mapleleaf.example/news', text: 'Since October 8, 2026 Maple Leaf Marketing is hiring an office manager in Toronto.' }, PAGES[2]]
  assert.equal((await judge(item(), brief(HIRE), hiring)).constraints, 'pass')
  assert.equal((await judge(item(), brief({ all_of: [{ geo: 'Toronto, CA' }, { event: 'job_posting', roles: ['receptionist'] }] }), hiring)).constraints, 'unknown')
  for (const extra of [{ segment: 'marketing agency' }, { headcount: [10, 100] }, { event: 'unheard_of_kind' }]) {
    const j = await judge(item(), brief({ all_of: [...TORONTO.all_of, extra] }))
    assert.equal(j.constraints, 'unknown', JSON.stringify(extra))
  }
  assert.equal((await judge(item(), brief({ ...TORONTO, none_of: [{ segment: 'franchise' }] }))).constraints, 'unknown')
  assert.equal((await judge(item(), brief({ all_of: [...TORONTO.all_of, { name: 'Maple' }] }))).constraints, 'pass')
  assert.equal((await judge(item(), brief({ all_of: [...TORONTO.all_of, { name: 'Mercury' }] }))).constraints, 'fail')
  assert.equal((await judge(item(), brief({ all_of: [{ geo: 'Toronto, CA' }, { any_of: [{ event: 'funding' }, { event: 'office_opening' }] }] }))).constraints, 'pass')
  for (const c of [null, 'Toronto', 42, [], { all_of: 'x' }]) assert.notEqual((await judge(item(), brief(c))).constraints, 'pass', JSON.stringify(c))
})

test('#397: dates and contacts fail closed: future, stale, publication-stamp-only, a hiring inbox, another domain and a former employee never pass', async () => {
  assert.equal((await judge(item({ event_date: '2026-11-15' }), brief(TORONTO), [{ url: 'https://news.example/maple', text: 'Maple Leaf Marketing will open a Toronto, Canada office on November 15, 2026 (mapleleaf.example).' }, PAGES[2]])).event_date, 'fail')
  assert.equal((await judge(item(), brief(TORONTO, 7))).event_date, 'fail')            // 12 days before as_of, a 7-day window
  assert.equal((await judge(item(), brief(TORONTO), [{ ...PAGES[0], meta_days: ['2026-10-08'] }, PAGES[1], PAGES[2]])).event_date, 'fail')
  assert.equal((await judge(item({ contact: 'jobs@mapleleaf.example' }), brief(TORONTO), [...PAGES.slice(0, 2), { url: 'https://mapleleaf.example/contact', text: 'Maple Leaf Marketing careers: jobs@mapleleaf.example' }])).contact, 'fail')
  assert.equal((await judge(item({ contact: 'hello@gmail.example' }), brief(TORONTO), [...PAGES.slice(0, 2), { url: 'https://mapleleaf.example/contact', text: 'hello@gmail.example' }])).contact, 'fail')
  assert.equal((await judge(item({ contact: 'hello@mapleleaf.example', contact_source_url: null }), brief(TORONTO))).contact, 'unknown')
  assert.equal((await judge(item({ contact: '+1 416 555 0100' }), brief(TORONTO))).contact, 'unknown')
  const former = await judge(item({ person: { name: 'Pat Example', title: 'Managing Director', source_url: 'https://mapleleaf.example/team' } }), brief(TORONTO), [...PAGES, { url: 'https://mapleleaf.example/team', text: 'Pat Example was Managing Director at Maple Leaf Marketing until 2024.' }])
  assert.equal(former.contact, 'fail')
  const fabricated = await judge(item({ quotes: [{ text: 'we are tripling our Toronto team', source_url: 'https://news.example/maple' }] }), brief(TORONTO))
  assert.equal(fabricated.event_date, 'fail')
})

test('#397: malformed snapshots fail closed and are recorded: wrong format, wrong-typed entries, conflicting captures, unreadable and huge pages', async () => {
  const ev = (raw: unknown) => verifierEvaluator({ snapshots: parseSnapshots(raw) })
  for (const raw of [null, [], 'x', 7, { format: 'other', version: 1, snapshots: [] }, { format: 'dazl-verifier-snapshots', version: 2, snapshots: [] }]) {
    const e = ev(raw); const j = (await e.judge([item()], brief(TORONTO))).b1
    assert.ok(fields(j).every(v => v !== 'pass'), JSON.stringify(raw)); assert.ok((e.config!.snapshot_problem_count as number) >= 1)
  }
  const s = parseSnapshots({ format: 'dazl-verifier-snapshots', version: 1, captured_by: '', captured_at: 'yesterday', snapshots: [null, 5, { url: 'ftp://x.example/a', outcome: 'ok', text: 'x' }, { url: 'https://a.example/', outcome: 'maybe' }, { url: 'https://b.example/', outcome: 'ok' }, { url: 'https://c.example/', outcome: 'ok', text: 'one' }, { url: 'https://c.example/', outcome: 'ok', text: 'two' }] })
  assert.equal(s.byUrl.size, 0)
  for (const p of [/captured_by is missing/, /captured_at is missing/, /snapshots\[0\] is not an object/, /snapshots\[2\] has no http\(s\) url/, /outcome "maybe"/, /neither text nor html/, /captured twice with different content/]) assert.ok(s.problems.some(x => p.test(x)), String(p))
  // an error outcome or a page cut at the size limit: the checks that need it are unknown, never fail or pass
  assert.equal((await judge(item(), brief(TORONTO), [{ url: 'https://news.example/maple', outcome: 'error' }, PAGES[1], PAGES[2]])).identity, 'unknown')
  const big = parseSnapshots({ format: 'dazl-verifier-snapshots', version: 1, captured_by: 'v', captured_at: '2026-10-20T00:00:00Z', snapshots: [{ url: 'https://big.example/', outcome: 'ok', text: 'a '.repeat(SNAPSHOT_LIMITS.text) }] })
  const b = big.byUrl.get('https://big.example/')!; assert.equal(b.text.length, SNAPSHOT_LIMITS.text); assert.equal(b.truncated, true)
  // two captures of one url that differ only in their declared canonical (same domain, so the linked domains match) conflict: both dropped, so input order cannot decide
  const html = (c: string) => `<html><head><link rel="canonical" href="${c}"></head><body><p>Same text.</p></body></html>`
  const two = parseSnapshots({ format: 'dazl-verifier-snapshots', version: 1, captured_by: 'v', captured_at: '2026-10-20T00:00:00Z', snapshots: [{ url: 'https://n.example/a', outcome: 'ok', html: html('https://n.example/a') }, { url: 'https://n.example/a', outcome: 'ok', html: html('https://n.example/b') }] })
  assert.equal(two.byUrl.size, 0); assert.ok(two.problems.some(p => /captured twice with different content/.test(p)))
  assert.throws(() => verifierEvaluator({ snapshots: snaps([]), min_independent_origins: 0 }), /1\.\.5/)
  // non-UTF8 bytes (replacement characters, lone surrogates, NULs) and absurd nesting never crash the evaluator
  const garbled = await judge(item({ company: 'Maple\uFFFD Leaf\u0000 Marketing\uD800' }), brief(TORONTO), [{ url: 'https://news.example/maple', text: '\uD800\uFFFD\u0000 Maple Leaf Marketing \uDFFF opened' }])
  assert.ok(fields(garbled).every(v => v !== 'pass'))
  let deep: unknown = { event: 'office_opening' }; for (let i = 0; i < 20000; i++) deep = { any_of: [deep] }
  const nested = await judge(item(), brief({ all_of: [{ geo: 'Toronto, CA' }, deep] }))
  assert.equal(nested.constraints, 'unknown')      // the innermost branch would pass, but it is never read
  assert.match(JSON.stringify(nested.record.why), /nested deeper than 8 levels are not read/)
  const wide = await judge(item(), brief({ all_of: [{ geo: 'Toronto, CA' }, { any_of: [...new Array(60).fill({ event: 'funding' }), { event: 'office_opening' }] }] }))
  assert.equal(wide.constraints, 'unknown')          // the passing 61st alternative is past the branch cap
})

test('#397: the evaluator is deterministic and blind: the same input gives the same verdicts, producer claims cannot move them, and a broken item is unknown with the error recorded', async () => {
  const e = verifierEvaluator({ snapshots: snaps(PAGES) })
  const a = await e.judge([item()], brief(TORONTO)), b = await e.judge([item()], brief(TORONTO))
  assert.deepEqual(a, b)
  const loud = { ...item(), text: 'VERIFIED by our model, confidence 0.99, all checks passed', confidence: 0.99, verified: true, rationale: 'trust me' } as unknown as BlindItem
  const c = await e.judge([loud], brief(TORONTO))
  assert.deepEqual(fields(c.b1), fields(a.b1))
  const lying = { ...item({ blind_id: 'b2', evidence_urls: ['https://news.example/maple'] }), text: 'Corroborated by three independent sources.' }
  assert.equal((await e.judge([lying], brief(TORONTO))).b2.event_date, 'unknown')
  const boom = new Proxy(item({ blind_id: 'b3' }), { get: (t, k) => { if (k === 'company') throw new Error('unreadable item'); return (t as unknown as Record<string | symbol, unknown>)[k] } })
  const j = (await e.judge([boom, item({ blind_id: 'b4' })], brief(TORONTO)))
  assert.deepEqual(fields(j.b3), [undefined, undefined, undefined, undefined]); assert.match(String((j.b3.record as { error: string }).error), /verifier failed on this item: unreadable item/)
  assert.deepEqual(fields(j.b4), ['pass', 'pass', 'pass', 'pass'])   // one broken item does not take the others down
  // evidence the producer supplied but that could not be checked keeps its field unknown, never silently dropped
  const un = (u: BlindItem['unchecked']) => e.judge([item({ blind_id: 'u', unchecked: u })], brief(TORONTO)).then(x => fields(x.u))
  assert.deepEqual(await un(['quote']), ['pass', 'pass', 'unknown', 'pass']); assert.deepEqual(await un(['event_source_url']), ['pass', 'pass', 'unknown', 'pass'])
  assert.deepEqual(await un(['person']), ['pass', 'pass', 'pass', 'unknown']); assert.deepEqual(await un(['contact_source_url']), ['pass', 'pass', 'pass', 'unknown'])
  // the verdicts are stated in the #394 contract's field vocabulary and folded by the contract's own mapping
  const rec = a.b1.record as { contract: string; contract_verdicts: { field: string; status: string }[] }
  assert.equal(rec.contract, CONTRACT_VERSION)
  assert.deepEqual(rec.contract_verdicts.map(x => x.field), ['identity.entity', 'place.matches', 'event.predicate', 'event.date_real', 'event.date_in_window', 'contact.usable'])
  for (const x of [a.b1, (await e.judge([item({ blind_id: 'b5', evidence_urls: ['https://news.example/maple'] })], brief(TORONTO))).b5]) {
    const r2 = x.record as { contract_verdicts: { field: string; status: string }[] }
    assert.deepEqual(scorecardVerdicts(r2.contract_verdicts), { identity: x.identity, constraints: x.constraints, event_date: x.event_date, contact: x.contact })
  }
})

test('#397: review findings: every counted origin must itself state the requested event, role and round in one unhedged sentence; regional HQ needs its own words; copies with other endings are one origin', async () => {
  // a different event the same day on the second origin does not corroborate the office opening
  const sameDay = [PAGES[0], { url: 'https://mapleleaf.example/news', text: 'On October 8, 2026 Maple Leaf Marketing raised a seed round from Example Ventures.' }, PAGES[2]]
  const j = await judge(item(), brief(TORONTO), sameDay)
  assert.equal(j.event_date, 'pass'); assert.equal(j.constraints, 'unknown')
  assert.match(JSON.stringify(j.record.why), /office_opening is stated on 1 independent origin\(s\); 2 are required/)
  // the role must be in the very sentence that states the hiring, and that sentence must not be negated
  const HIRE = { all_of: [{ geo: 'Toronto, CA' }, { event: 'job_posting', roles: ['office manager'] }] }
  const split = [{ url: 'https://news.example/maple', text: 'On October 8, 2026 Maple Leaf Marketing (mapleleaf.example) in Toronto, Canada is hiring engineers. On October 8, 2026 Maple Leaf Marketing said it is not hiring an office manager.' }, { url: 'https://mapleleaf.example/news', text: 'Since October 8, 2026 Maple Leaf Marketing is hiring engineers in Toronto.' }, PAGES[2]]
  assert.equal((await judge(item(), brief(HIRE), split)).constraints, 'unknown')
  const FUND = { all_of: [{ geo: 'Toronto, CA' }, { event: 'funding', stage: 'seed' }] }
  const rounds = [{ url: 'https://news.example/maple', text: 'Maple Leaf Marketing (mapleleaf.example) of Toronto, Canada raised a Series B round on October 8, 2026. Its seed investors cheered.' }, { url: 'https://mapleleaf.example/news', text: 'On October 8, 2026 Maple Leaf Marketing raised a Series B round in Toronto.' }, PAGES[2]]
  assert.equal((await judge(item(), brief(FUND), rounds)).constraints, 'unknown')
  // a regional headquarters needs those words, not any opening
  const HQ = { all_of: [{ geo: 'Dubai, AE' }, { event: 'regional_hq' }] }
  const dubai = (what: string) => [{ url: 'https://news.example/maple', text: `Maple Leaf Marketing (mapleleaf.example) ${what} in Dubai, United Arab Emirates on October 8, 2026.` }, { url: 'https://mapleleaf.example/news', text: `On October 8, 2026 Maple Leaf Marketing ${what} in Dubai.` }, PAGES[2]]
  assert.equal((await judge(item(), brief(HQ), dubai('opened a new store'))).constraints, 'unknown')
  assert.equal((await judge(item(), brief(HQ), dubai('opened its regional headquarters'))).constraints, 'pass')
  // a copied sentence that ends the page on one site and is followed by a footer on another is still one origin
  const copies = [PAGES[0], { url: 'https://wire.example/maple', text: `${PAGES[0].text!.split('. ')[0]}. Read more on our wire. Subscribe.` }, PAGES[2]]
  const c = await judge(item({ evidence_urls: ['https://news.example/maple', 'https://wire.example/maple'] }), brief(TORONTO), copies)
  assert.equal(c.record.independent_origins, 1); assert.equal(c.event_date, 'unknown')
})

test('#397: the verifier can corroborate from pages it found itself for the company, the same for every system, never for another company', async () => {
  const one = item({ evidence_urls: ['https://news.example/maple'] })
  const e = verifierEvaluator({ snapshots: parseSnapshots({ format: 'dazl-verifier-snapshots', version: 1, captured_by: 'dazl-verifier (test)', captured_at: '2026-10-20T12:00:00Z', found_by_verifier: { 'mapleleaf.example': ['https://mapleleaf.example/news'], 'other.example': ['https://x.example/'] }, snapshots: PAGES.map(s => ({ outcome: 'ok', final_url: null, truncated: false, meta_days: [], linked_domains: [], ...s })) }) })
  const j = (await e.judge([one], brief(TORONTO))).b1 as Judgement & { record: Record<string, unknown> }
  assert.deepEqual(fields(j), ['pass', 'pass', 'pass', 'pass']); assert.deepEqual(j.record.verifier_found_sources, ['https://mapleleaf.example/news'])
  const other = (await e.judge([{ ...one, blind_id: 'b9', domain: 'lakeshore.example' }], brief(TORONTO))).b9 as Judgement & { record: Record<string, unknown> }
  assert.deepEqual(other.record.verifier_found_sources, [])
  // a malformed found_by_verifier is recorded and ignored
  const bad = parseSnapshots({ format: 'dazl-verifier-snapshots', version: 1, captured_by: 'v', captured_at: '2026-10-20T12:00:00Z', found_by_verifier: { 'mapleleaf.example': 'https://x.example/' }, snapshots: [] })
  assert.equal(bad.found.size, 0); assert.ok(bad.problems.some(p => /found_by_verifier\["mapleleaf.example"\]/.test(p)))
  assert.ok(parseSnapshots({ format: 'dazl-verifier-snapshots', version: 1, captured_by: 'v', captured_at: '2026-10-20T12:00:00Z', found_by_verifier: [], snapshots: [] }).problems.some(p => /found_by_verifier is not an object/.test(p)))
  // the hash covers only the bounded content: an ignored tail past the entry limit is never traversed into it
  const head = Array.from({ length: SNAPSHOT_LIMITS.snapshots }, (_, i) => ({ url: `https://p${i}.example/`, outcome: 'error' }))
  const base = { format: 'dazl-verifier-snapshots', version: 1, captured_by: 'v', captured_at: '2026-10-20T12:00:00Z' }
  assert.equal(parseSnapshots({ ...base, snapshots: head }).sha256, parseSnapshots({ ...base, snapshots: [...head, { url: 'https://tail.example/', outcome: 'ok', text: 'x'.repeat(1000) }] }).sha256)
})

// ------------------------------------------------------------------------------------- the one-command synthetic batch

test('#397 #788: one command reproduces a verifier-scored batch: per-tool P@5/P@10, unique actionable yield, coverage, time, spend and interventions', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-verified-'))
  try {
    const run = () => execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/benchmark.mts', 'run', '--batch', FIXTURE, '--store', path.join(dir, 'store.json'), '--out', dir], { cwd: WEB, encoding: 'utf8' })
    const first = run(), second = run()
    assert.match(first, /SYNTHETIC fixtures: not live results of any product/)
    assert.match(first, /Evaluator: dazl-verifier-deterministic v1 \(blind to system\)/)
    assert.match(first, /\| dazl \| ran \| 3 \/ 3 \| 0\.75 \| 0\.67 \| 2 \| 2 \| 57 \| \$1\.1 \| 0 \|/)
    assert.match(first, /\| chatgpt-web-baseline \| ran \| 3 \/ 3 \| 0\.00 \| 0\.00 \| 0 \| 0 \| 108 \| unknown \| 9 \|/)
    assert.match(first, /\| pancake \| unavailable: no authorized Pancake account \(NEEDS GAGAN\) \| 0 \/ 3 \| n\/a \| n\/a \| 0 \| 0 \| n\/a \| n\/a \| 0 \|/)
    assert.match(first, /runs: 12 new, 0 reused/); assert.match(second, /runs: 0 new, 12 reused/)
    assert.equal(first.split('\n\nruns:')[0], second.split('\n\nruns:')[0])
    // the same runs scored at another corroboration level: same batch_id (no run repeated), another scored_id, another file
    const f1 = JSON.parse(readFileSync(FIXTURE, 'utf8')) as BatchFile
    writeFileSync(path.join(dir, 'one-origin.json'), JSON.stringify({ ...f1, evaluator: { ...f1.evaluator!, min_independent_origins: 1 } }))
    const third = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/benchmark.mts', 'run', '--batch', path.join(dir, 'one-origin.json'), '--store', path.join(dir, 'store.json'), '--out', dir], { cwd: WEB, encoding: 'utf8' })
    assert.match(third, /runs: 0 new, 12 reused/)
    const id = (s: string) => /# Benchmark batch (\w+) \(scored (\w+)\)/.exec(s)!.slice(1)
    assert.equal(id(third)[0], id(first)[0]); assert.notEqual(id(third)[1], id(first)[1])
    assert.equal(readdirSync(dir).filter(x => x.startsWith('batch-') && x.endsWith('.json')).length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('#397: the synthetic verified batch: why each lead is or is not validated is recorded, and labels and the verifier never judge one batch together', async () => {
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as BatchFile
  const r = await runBatch(batchFromFile(structuredClone(f)))
  const by = (s: string, e: string) => r.evaluations.find(x => x.system === s && x.entity_key === e)!
  assert.deepEqual(Object.values(by('dazl', 'domain:mapleleaf.example').verdicts), ['pass', 'pass', 'pass', 'pass'])
  assert.equal(by('dazl', 'domain:lakeshore.example').verdicts.event_date, 'unknown')                          // one source only
  assert.equal(by('chatgpt-web-baseline', 'domain:querix.example').verdicts.event_date, 'unknown')            // a syndicated copy
  assert.equal(by('chatgpt-web-baseline', 'domain:mapleleaf.example').verdicts.contact, 'unknown')            // no route given
  assert.deepEqual(Object.values(by('chatgpt-web-baseline', 'domain:harbourstudio.example').verdicts), ['unknown', 'unknown', 'unknown', 'unknown'])  // a firmographic guess
  assert.equal(by('chatgpt-web-baseline', 'domain:reykjavikrobotics.example').verdicts.event_date, 'fail')     // a future IPO on the negative task
  assert.equal(r.scorecards.find(c => c.system === 'chatgpt-web-baseline')!.totals.false_alerts, 0)
  assert.equal(r.manifest.evaluator.config!.min_independent_origins, 2)
  assert.ok(r.scorecards.every(c => !c.evaluable))                                                           // synthetic: never release evidence
  assert.throws(() => batchFromFile({ ...structuredClone(f), labels: {} }), /labels or by the verifier, never both/)
  assert.throws(() => batchFromFile({ ...structuredClone(f), evaluator: { kind: 'model' } as never }), /evaluator must be/)
  assert.throws(() => batchFromFile({ ...structuredClone(f), evaluator: { ...f.evaluator!, min_independent_origins: 9 } }), /1\.\.5/)
  assert.throws(() => batchFromFile({ ...structuredClone(f), evaluator: undefined }), /needs labels or a verifier/)
})

// -------------------------------------------------------------------------------------------- the adapter registry

test('#397 #787: the committed registry: dazl plus every competitor and the plain-chat baseline; none of the three is authorized today', () => {
  const reg = checkRegistry(REGISTRY)
  assert.deepEqual(reg.map(e => e.system), ['dazl', 'pancake', 'gojiberry', 'chatgpt-web-baseline'])
  for (const e of reg.filter(x => x.system !== 'dazl')) { assert.equal(e.requires_authorization, true); assert.match(authorizationProblem(e.authorization, e.system)!, /no owner authorization/); assert.match(e.unavailable_reason!, /NEEDS GAGAN/) }
  const bad = (systems: unknown) => () => checkRegistry({ format: 'dazl-benchmark-adapters', version: 1, systems })
  assert.throws(bad([]), /no system/); assert.throws(bad([{ system: 'Pan Cake!', requires_authorization: true }]), /plain system name/)
  assert.throws(bad([{ system: 'dazl', requires_authorization: false }, { system: 'dazl', requires_authorization: false }]), /twice/)
  assert.throws(bad([{ system: 'pancake', requires_authorization: false }]), /every system other than dazl requires an owner authorization/)
  assert.throws(bad([{ system: 'pancake', requires_authorization: 'yes' }]), /true or false/)
  for (const r of [null, [], 'x', { format: 'dazl-benchmark-adapters', version: 2, systems: [] }]) assert.throws(() => checkRegistry(r), /not a dazl-benchmark-adapters v1/)
})

test('#397 #787: an authorization is the owner\'s own words with a time, channel, scope naming the system and a cap; anything else leaves the system unavailable', () => {
  const ok = { granted_by: 'gagan', granted_at: '2026-11-10T09:36:00-05:00', owner_words: 'I approve one Pancake benchmark run, cap $20', channel: 'whatsapp', scope: 'one pancake recorded batch on task set v1', max_usd: 20, task_set_version: '1', recording_sha256: 'a'.repeat(64) }
  assert.equal(authorizationProblem(ok, 'pancake'), null)
  const cases: [unknown, RegExp][] = [
    [null, /no owner authorization/], ['yes', /not an object/], [[], /not an object/], [{ ...ok, granted_by: 'gagan114662' }, /only the owner/], [{ ...ok, granted_by: 'instinct' }, /only the owner/],
    [{ ...ok, granted_at: '2026-11-10' }, /date and time/], [{ ...ok, granted_at: 20261110 }, /date and time/], [{ ...ok, owner_words: 'ok' }, /own words/], [{ ...ok, owner_words: 'x'.repeat(501) }, /own words/],
    [{ ...ok, channel: '' }, /channel/], [{ ...ok, scope: 'one gojiberry batch' }, /scope must name the system pancake/], [{ ...ok, max_usd: -1 }, /preset non-negative cap/], [{ ...ok, max_usd: '20' }, /preset non-negative cap/],
    [{ ...ok, max_usd: Infinity }, /preset non-negative cap/], [{ ...ok, widen_later: true }, /unknown authorization field/],
    [{ ...ok, task_set_version: undefined }, /task_set_version/], [{ ...ok, recording_sha256: 'abc' }, /recording_sha256/], [{ ...ok, recording_sha256: undefined }, /recording_sha256/],
  ]
  for (const [a, re] of cases) assert.match(authorizationProblem(a, 'pancake')!, re, JSON.stringify(a))
})

// ----------------------------------------------------------------------------------------------------- recordings

const rec = (over: Record<string, unknown> = {}, tasks: Record<string, unknown> = { 'toronto-dental': { items: [], cost_usd: 0.5, seconds: 10, interventions: 0 } }) => ({
  format: RECORDING_FORMAT, version: 1, system: 'dazl', task_set_version: '1', captured_at: '2026-11-01T10:00:00Z',
  config: { product: 'dazl', product_version: 'abc123', model: 'm', sources: ['scan'], paid: true }, tasks, ...over,
})

test('#397 #786: a recording is checked whole against the frozen set: wrong format, system, version, foreign task, bad config or time refuse it; a bad task fails only that task', async () => {
  assert.equal(checkRecording(rec(), V1, 'dazl').origin, 'recorded')
  const refused: [unknown, RegExp][] = [
    [null, /not a dazl-benchmark-recording/], [rec({ version: 2 }), /not a dazl-benchmark-recording/], [rec({ system: 'pancake' }), /recording is of system "pancake"/],
    [rec({ task_set_version: '2' }), /ran task set v"2"/], [rec({ captured_at: 'soon' }), /captured_at/], [rec({ tasks: [] }), /keyed by task id/],
    [rec({}, { 'not-a-task': { items: [] } }), /not in frozen task set v1: not-a-task/], [rec({ config: null }), /no config/], [rec({ config: { product: '', sources: [], paid: true } }), /config.product/],
    [rec({ config: { product: 'dazl', sources: 'scan', paid: true } }), /config.sources/], [rec({ config: { product: 'dazl', sources: [], paid: 'yes' } }), /config.paid/], [rec({ config: { product: 'dazl', model: 7, sources: [], paid: true } }), /config.model/],
  ]
  for (const [r, re] of refused) assert.throws(() => checkRecording(r, V1, 'dazl'), re, JSON.stringify(r).slice(0, 80))
  const f = checkRecording(rec({}, {
    'toronto-dental': null, 'lisbon-sales': { items: 'x' }, 'pune-schools': { items: [], cost_usd: -1, seconds: 1, interventions: 0 }, 'gurugram-offices': { items: [], cost_usd: 1, seconds: 1, interventions: 0.5 },
    'nyc-dental-local': { items: new Array(501).fill({ company: 'x' }), cost_usd: 1, seconds: 1, interventions: 0 }, 'dubai-b2b-launch': { items: [], cost_usd: 1, seconds: 1, interventions: 0, stopped: 'tired' },
    'london-saas-revops': { error: 'the product returned 500' },
  }), V1, 'dazl')
  assert.match((f.tasks['toronto-dental'] as { error: string }).error, /not an object/)
  assert.match((f.tasks['lisbon-sales'] as { error: string }).error, /items is not a list/)
  assert.match((f.tasks['pune-schools'] as { error: string }).error, /cost_usd -1/)
  assert.match((f.tasks['gurugram-offices'] as { error: string }).error, /interventions 0.5/)
  assert.match((f.tasks['nyc-dental-local'] as { error: string }).error, /501 items, at most 500/)
  assert.match((f.tasks['dubai-b2b-launch'] as { error: string }).error, /stopped "tired"/)
  // a different recording is a different batch: its sha256 is in the system config
  assert.notEqual(checkRecording(rec(), V1, 'dazl').config.notes, checkRecording(rec({ captured_at: '2026-11-02T10:00:00Z' }), V1, 'dazl').config.notes)
})

const SB = {
  commit: 'abc1234', date: '2026-11-01', model: 'claude-sonnet-4-5', rows: [
    { id: 'toronto-dental', complete: true, error: null, seconds: 120, leads: [
      { company: 'Queen West Dental', company_domain: 'queenwestdental.example', event_date: '2026-10-20', source_url: 'https://news.example/qwd', signal: 'opened a second clinic', quarantined_at: null,
        person_title: 'Dr. Pat Example, Owner', routes: [{ kind: 'email', value: 'pat@queenwestdental.example', role_ok: true }, { kind: 'email', value: 'jobs@queenwestdental.example', role_ok: false }],
        site_evidence: [{ kind: 'person', value: 'Dr. Pat Example, Owner', source_url: 'https://queenwestdental.example/team' }, { kind: 'email', value: 'pat@queenwestdental.example', source_url: 'https://queenwestdental.example/contact' }] },
      { company: 'Hidden Dental', company_domain: null, event_date: null, source_url: 'https://x.example', quarantined_at: 1730000000 },
      { company: 'No Evidence Dental', company_domain: null, event_date: null, source_url: 'https://y.example', person_title: 'Sam Example, Owner', routes: [{ kind: 'email', value: 'sam@ned.example', role_ok: true }] },
    ] },
    { id: 'lisbon-sales', complete: false, error: 'budget_stopped', seconds: 30, leads: [] },
    { id: 'ohio-payroll', complete: false, error: 'key_rejected', seconds: 1, leads: [] },
  ],
}

test('#397 #786: the Dazl adapter: a scoreboard result becomes a recording with raw evidence, unknown cost, stops kept, quarantined leads not presented', () => {
  const r = dazlRecordingFromScoreboard(structuredClone(SB), V1)
  const t = r.tasks['toronto-dental'] as { items: Record<string, unknown>[]; cost_usd: unknown }
  assert.equal(t.cost_usd, null)                                   // one shared budget in the scoreboard: unknown per task, never 0
  assert.deepEqual(t.items.map(i => i.company), ['Queen West Dental', 'No Evidence Dental'])
  assert.deepEqual(t.items[0], { company: 'Queen West Dental', domain: 'queenwestdental.example', contact: 'pat@queenwestdental.example', contact_source_url: 'https://queenwestdental.example/contact', event_date: '2026-10-20', event_source_url: 'https://news.example/qwd', evidence_urls: ['https://news.example/qwd'], text: 'opened a second clinic', person: { name: 'Dr. Pat Example', title: 'Owner', source_url: 'https://queenwestdental.example/team' }, original: SB.rows[0].leads[0] })
  assert.match((dazlRecordingFromScoreboard({ ...SB, rows: [{ id: 'toronto-dental', complete: true, seconds: 1, leads: 'truncated' }] }, V1).tasks['toronto-dental'] as { error: string }).error, /leads is not a list \(a truncated result is not an empty market\)/)
  assert.deepEqual([t.items[1].person, t.items[1].contact_source_url], [null, null])     // no page recorded for them: those checks will be unknown
  assert.deepEqual(r.tasks['lisbon-sales'], { items: [], cost_usd: null, seconds: 30, interventions: 0, stopped: 'budget', detail: 'budget_stopped' })
  assert.match((r.tasks['ohio-payroll'] as { error: string }).error, /did not complete: key_rejected/)
  assert.deepEqual([r.config.product_version, r.config.model, r.system, r.task_set_version], ['abc1234', 'claude-sonnet-4-5', 'dazl', '1'])
  assert.equal(checkRecording(r, V1, 'dazl').tasks['toronto-dental'] !== undefined, true)
  for (const [bad, re] of [[null, /not a scripts\/scoreboard.mts result/], [{ ...SB, date: 'Nov 1' }, /date/], [{ ...SB, rows: [{ id: 'mars-dental', complete: true, leads: [] }] }, /not a task of frozen task set v1/], [{ ...SB, rows: [SB.rows[1], SB.rows[1]] }, /recorded twice/], [{ ...SB, rows: [7] }, /has no id/]] as [unknown, RegExp][]) assert.throws(() => dazlRecordingFromScoreboard(bad, V1), re)
  // the scoreboard harness records the page each person and route was read on
  assert.match(readFileSync(path.join(WEB, 'scripts', 'scoreboard.mts'), 'utf8'), /site_evidence = own\.map\(r => \(\{ kind: r\.kind, value: r\.value, source_url: r\.source_url \}\)\)/)
})

// ------------------------------------------------------------------------------------------------- recorded batches

const recordedFile = (over: Record<string, unknown> = {}) => ({ format: 'dazl-benchmark-recorded-batch', version: 1, as_of: '2026-11-01', seed: 3, budget: { usd_per_task: 2, seconds_per_task: 600, batch_usd: 40 }, task_set_version: '1', recordings: { dazl: 'dazl.json' }, snapshots: 'snaps.json', min_independent_origins: 2, ...over })
const files: Record<string, unknown> = {
  'dazl.json': dazlRecordingFromScoreboard(structuredClone(SB), V1),
  'pancake.json': { ...rec({ system: 'pancake' }), config: { product: 'Pancake', product_version: 'x', model: null, sources: ['scraped'], paid: true } },
  'snaps.json': { format: 'dazl-verifier-snapshots', version: 1, captured_by: 'dazl-verifier (test)', captured_at: '2026-11-01T12:00:00Z', snapshots: [] },
}
const deps = (over: Partial<Parameters<typeof recordedBatch>[1]> = {}) => ({ registry: REGISTRY, committedSet: V1, read: (f: string) => { if (!(f in files)) throw new Error(`no file ${f}`); return structuredClone(files[f]) }, ...over })

test('#397 #787: a recorded batch: every registry system is in it, an unauthorized competitor is unavailable and its supplied recording ignored, and the verifier judges', async () => {
  const { options, notes } = recordedBatch(recordedFile({ recordings: { dazl: 'dazl.json', pancake: 'pancake.json' } }), deps())
  assert.deepEqual(notes.map(n => [n.system, n.used]), [['dazl', true], ['pancake', false], ['gojiberry', false], ['chatgpt-web-baseline', false]])
  assert.match(notes[1].reason!, /no authorized Pancake account \(NEEDS GAGAN.*\) \(no owner authorization is recorded\); a recording was supplied and ignored: it is not authorized/)
  const r = await runBatch(options)
  assert.equal(r.manifest.origin, 'recorded'); assert.equal(r.manifest.label, 'recorded outputs')
  assert.deepEqual([r.manifest.evaluator.name, r.manifest.evaluator.independent], ['dazl-verifier-deterministic', true])
  const by = Object.fromEntries(r.report.map(s => [s.system, s]))
  assert.deepEqual([by.pancake.status, by.pancake.coverage, by.pancake.precision_at_10, by.pancake.spend_usd], ['unavailable', null, null, null])
  assert.deepEqual([by.dazl.status, by.dazl.attempted, by.dazl.complete], ['ran', 3, 1])     // 3 recorded tasks attempted, the other 11 unsupported (no recording)
  assert.equal(by.dazl.validated, 0)                                                          // no snapshot was captured: nothing is shown, so nothing is validated
  assert.ok(r.evaluations.every(e => e.system === 'dazl'))
  // an authorized competitor's recording is replayed; a malformed authorization leaves it unavailable
  const reg = structuredClone(REGISTRY) as { systems: Record<string, unknown>[] }
  const grant = { granted_by: 'gagan', granted_at: '2026-11-10T09:36:00-05:00', owner_words: 'I approve one Pancake benchmark run, cap $20', channel: 'whatsapp', scope: 'pancake recorded batch', max_usd: 20, task_set_version: '1', recording_sha256: recordingSha(files['pancake.json']) }
  const withGrant = (g: unknown) => { const x = structuredClone(reg); x.systems[1].authorization = g; return recordedBatch(recordedFile({ recordings: { dazl: 'dazl.json', pancake: 'pancake.json' } }), deps({ registry: x })).notes[1] }
  assert.equal(withGrant(grant).used, true)
  assert.equal(withGrant({ ...grant, granted_by: 'gagan114662' }).used, false)
  assert.match(withGrant({ ...grant, recording_sha256: 'b'.repeat(64) }).reason!, /covers a different recording/)          // one grant, one recording
  assert.match(withGrant({ ...grant, task_set_version: '2' }).reason!, /covers task set v2, not v1/)
  assert.match(withGrant({ ...grant, max_usd: 0.25 }).reason!, /worst-case exposure \$0.5 is over the authorized cap \$0.25/)
})

test('#397 #787: a recorded batch refuses what it cannot run honestly: no committed set, another version, no snapshots, an unknown system, a foreign recording', () => {
  const refused: [unknown, Partial<Parameters<typeof recordedBatch>[1]>, RegExp][] = [
    [recordedFile(), { committedSet: null }, /must run a committed frozen task set/], [recordedFile({ task_set_version: '2' }), {}, /names task set v"2"/],
    [recordedFile({ snapshots: '' }), {}, /snapshots \(the verifier's own captures\) is required/], [recordedFile({ recordings: { acme: 'dazl.json' } }), {}, /not in the adapter registry: acme/],
    [recordedFile({ recordings: { dazl: 'pancake.json' } }), {}, /recording is of system "pancake"/], [recordedFile({ seed: 1.5 }), {}, /seed/], [recordedFile({ budget: { usd_per_task: '2' } }), {}, /budget/],
    [recordedFile({ recordings: { dazl: 7 } }), {}, /map a system to a recording file/], [recordedFile({ min_independent_origins: 0 }), {}, /1\.\.5/], [{ ...recordedFile(), format: 'x' }, {}, /not a dazl-benchmark-recorded-batch/],
    [recordedFile(), { registry: { format: 'nope' } }, /adapter registry/],
    [recordedFile({ min_independent_origins: undefined }), {}, /min_independent_origins is required/],
  ]
  for (const [f, d, re] of refused) assert.throws(() => recordedBatch(f, deps(d)), re, JSON.stringify(f).slice(0, 100))
  // snapshots must be attributed to the verifier, never to a system under test
  const snapsBy = (over: Record<string, unknown>) => deps({ read: (f: string) => f === 'snaps.json' ? { ...(files['snaps.json'] as object), ...over } : structuredClone(files[f]) })
  assert.throws(() => recordedBatch(recordedFile(), snapsBy({ captured_by: undefined })), /not attributed to the verifier/)
  assert.throws(() => recordedBatch(recordedFile(), snapsBy({ captured_at: 'later' })), /not attributed to the verifier/)
  assert.throws(() => recordedBatch(recordedFile(), snapsBy({ format: 'x' })), /not attributed to the verifier/)
  for (const by of ['Pancake export', 'gojiberry', 'dazl scan pipeline']) assert.throws(() => recordedBatch(recordedFile(), snapsBy({ captured_by: by })), /a system under test, not by the verifier/, by)
  assert.doesNotThrow(() => recordedBatch(recordedFile(), snapsBy({ captured_by: 'dazl-verifier capture v1' })))
  // labels can never score a recorded batch, and a recorded output never sits beside a synthetic one
  assert.throws(() => batchFromFile({ ...(JSON.parse(readFileSync(FIXTURE, 'utf8')) as BatchFile), systems: [{ system: 'dazl', origin: 'recorded', config: { product: 'dazl', product_version: null, model: null, sources: [], paid: false }, tasks: {} }], evaluator: undefined, labels: {} }), /labels are ground truth only for synthetic batches/)
})

test('#397 #788: CLI: the recorded batch runs from files beside it with the committed registry, exits 2 on invalid input, and dazl-recording converts a scoreboard result', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-recorded-'))
  try {
    writeFileSync(path.join(dir, 'sb.json'), JSON.stringify(SB))
    const node = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/benchmark.mts', ...args], { cwd: WEB, encoding: 'utf8' })
    const conv = node(['dazl-recording', '--result', path.join(dir, 'sb.json'), '--out', path.join(dir, 'dazl.json')])
    assert.equal(conv.status, 0, conv.stderr); assert.match(conv.stdout, /dazl recording of 3 task\(s\)/)
    writeFileSync(path.join(dir, 'pancake.json'), JSON.stringify(files['pancake.json'])); writeFileSync(path.join(dir, 'snaps.json'), JSON.stringify(files['snaps.json']))
    writeFileSync(path.join(dir, 'batch.json'), JSON.stringify(recordedFile({ recordings: { dazl: 'dazl.json', pancake: 'pancake.json' } })))
    const ok = node(['run', '--batch', path.join(dir, 'batch.json'), '--out', dir])
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /\*\*recorded outputs\.\*\* Task set v1/)
    assert.match(ok.stdout, /\| pancake \| unavailable: no authorized Pancake account/)
    assert.match(ok.stdout, /- pancake: no authorized Pancake account .*a recording was supplied and ignored/)
    assert.match(ok.stdout, /- dazl: recording replayed/)
    for (const [name, body] of [['b1.json', recordedFile({ recordings: { evil: 'dazl.json' } })], ['b2.json', recordedFile({ snapshots: 'missing.json' })], ['b3.json', recordedFile({ task_set_version: '9' })]] as [string, unknown][]) {
      writeFileSync(path.join(dir, name), JSON.stringify(body))
      const bad = node(['run', '--batch', path.join(dir, name)])
      assert.equal(bad.status, 2, name); assert.match(bad.stderr, /invalid_input/, name)
    }
    const badConv = node(['dazl-recording', '--result', path.join(dir, 'batch.json'), '--out', path.join(dir, 'x.json')])
    assert.equal(badConv.status, 2); assert.match(badConv.stderr, /not a scripts\/scoreboard.mts result/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
