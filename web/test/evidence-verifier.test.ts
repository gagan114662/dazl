// Independent evidence verifier (#395). Every company, page, person and address below is SYNTHETIC, every source is
// answered by a stub fetcher and every judge is a stub: nothing reaches the network or a model.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { bothEngines } from './helpers/engines.ts'
import { blindClaim } from '../lib/verifier/claim.ts'
import { replayRecord, verifyClaim, type FetchResult, type Judge, type SourceFetcher, type VerifyOptions } from '../lib/verifier/service.ts'
import { getVerdict, listVerdicts } from '../lib/verifier/store.ts'
import { datesIn, fold } from '../lib/verifier/text.ts'

const AS_OF = '2026-11-03T12:00:00.000Z'
const NOW = Date.parse(AS_OF)
const A = 'tenant-verifier-aaaa', B = 'tenant-verifier-bbbb'
const OWN = 'https://harborledger.example/news/london-office'
const page = (body: string, head = '') => `<html><head><title>Synthetic</title>${head}</head><body>${body}</body></html>`
const GENUINE = page(`<p>Harbor Ledger Analytics opened its new London office on October 20, 2026.</p>
  <p>&ldquo;We are hiring our first sales team in London,&rdquo; said Priya Raman, Chief Revenue Officer at Harbor Ledger Analytics.</p>
  <p>Press: <a href="mailto:priya.raman@harborledger.example">priya.raman@harborledger.example</a></p>`)

const claim = (over: Record<string, unknown> = {}) => ({
  company: 'Harbor Ledger Analytics', domain: 'harborledger.example', place: { city: 'London', country: 'United Kingdom' },
  event: { date: '2026-10-20', source_url: OWN },
  quotes: [{ text: 'We are hiring our first sales team in London', source_url: OWN }],
  person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: OWN },
  contact: { email: 'priya.raman@harborledger.example', source_url: OWN },
  ...over,
})

function stub(pages: Record<string, string | FetchResult | 'hang'>): SourceFetcher & { calls: string[] } {
  const calls: string[] = []
  const f: SourceFetcher = async (url) => {
    calls.push(url)
    const p = pages[url]
    if (p === undefined) return { ok: false, error: 'error', status: 404 }
    if (p === 'hang') return new Promise<FetchResult>(() => {})
    return typeof p === 'string' ? { ok: true, html: p, final_url: url, status: 200 } : p
  }
  return Object.assign(f, { calls })
}
function store(): Db { const raw = new Database(':memory:'); migrateAllSqlite(raw); return sqliteDb(raw) }
const run = (input: unknown, pages: Record<string, string | FetchResult | 'hang'>, o: Partial<VerifyOptions> = {}) =>
  verifyClaim(input, { tenantId: A, asOf: AS_OF, now: () => NOW, db: o.db ?? store(), fetchSource: stub(pages), fetchTimeoutMs: 30, judgeTimeoutMs: 30, ...o })
const status = (rec: { checks: { check: string; status: string }[] }, check: string) => rec.checks.filter(c => c.check === check).map(c => c.status)

test('genuine control: first-party source, quote, current person and route on it -> pass/accept, replayable', async () => {
  const { record, persisted } = await run(claim(), { [OWN]: GENUINE })
  assert.deepEqual(record.checks.filter(c => c.status !== 'pass'), [])
  assert.equal(record.verdict, 'pass'); assert.equal(record.action, 'accept'); assert.equal(persisted, true)
  assert.equal(record.verifier_version, 'evidence-verifier/1'); assert.equal(record.record_version, 1)
  assert.ok(record.sources[0].sha256 && record.sources[0].sha256.length === 64)
  assert.equal(replayRecord(record).same, true)
})

test('wrong-city / same-name company: a page about the namesake in Paris on another domain does not pass', async () => {
  const url = 'https://citywire.example.org/harbor-ledger-paris'
  const { record } = await run(claim({ event: { date: '2026-10-20', source_url: url }, quotes: [{ text: 'opened an office in Paris', source_url: url }], person: null, contact: null }),
    { [url]: page('<p>Harbor Ledger Analytics opened an office in Paris on October 20, 2026. <a href="https://harborledger.fr">site</a></p>') })
  assert.deepEqual(status(record, 'place_on_source'), ['fail'])
  assert.deepEqual(status(record, 'domain_bound'), ['unknown'])
  assert.equal(record.verdict, 'fail'); assert.equal(record.action, 'skip')
  // a whole word, not a substring: Londonderry is not London
  const derry = await run(claim({ event: { date: '2026-10-20', source_url: url }, quotes: [{ text: 'opened an office', source_url: url }], person: null, contact: null }),
    { [url]: page('<p>Harbor Ledger Analytics (harborledger.example) opened an office in Londonderry on October 20, 2026.</p>') })
  assert.deepEqual(status(derry.record, 'place_on_source'), ['fail'])
})

test('old article with a fresh publication date: the stamp or the metadata day is not the event day', async () => {
  const visible = page('<p>Updated October 28, 2026</p><p>Harbor Ledger Analytics opened its London office in March 2019. "We are hiring our first sales team in London," said the firm.</p>')
  const metaOnly = page('<p>Harbor Ledger Analytics opened its London office in March 2019. "We are hiring our first sales team in London," said the firm.</p>', '<meta property="article:published_time" content="2026-10-28T09:00:00Z">')
  for (const html of [visible, metaOnly]) {
    const { record } = await run(claim({ event: { date: '2026-10-28', source_url: OWN }, person: null, contact: null }), { [OWN]: html })
    assert.deepEqual(status(record, 'event_date_on_source'), ['fail'], record.checks.find(c => c.check === 'event_date_on_source')!.reason)
    assert.match(record.checks.find(c => c.check === 'event_date_on_source')!.reason, /publication\/update date/)
    assert.equal(record.action, 'skip')
  }
})

test('dates are whole tokens: 2026-10-080123, x2026-10-08x and "18 October 2026" do not state October 8', () => {
  assert.deepEqual(datesIn(fold('Ref 2026-10-080123 and x2026-10-08x and 18 October 2026')).map(d => d.iso), ['2026-10-18'])
  assert.deepEqual(datesIn(fold('On 2026-10-08, Oct. 8, 2026, October 8 2026 and 8 October 2026.')).map(d => d.iso), ['2026-10-08', '2026-10-08', '2026-10-08', '2026-10-08'])
  assert.deepEqual(datesIn(fold('February 30, 2026 and 2026-02-29')), [])
})

test('fabricated quote fails, and the producer\'s own excerpt, verdict and rationale cannot rescue it', async () => {
  const input = { ...claim({ quotes: [{ text: 'We plan to triple headcount in London', source_url: OWN }] }),
    evidence_excerpt: 'We plan to triple headcount in London', verified: true, model: 'producer-model-x', rationale: 'the quote is on the page', confidence: 0.99, score: 97 }
  const { record } = await run(input, { [OWN]: GENUINE })
  assert.deepEqual(status(record, 'quote_on_source'), ['fail'])
  assert.equal(record.action, 'skip')
  assert.deepEqual(record.dropped_fields, ['confidence', 'evidence_excerpt', 'model', 'rationale', 'score', 'verified'])
  assert.equal(JSON.stringify(record).includes('producer-model-x'), false, 'producer identity is not stored')
  assert.equal(JSON.stringify(record).includes('the quote is on the page'), false, 'producer rationale is not stored')
})

test('blinding: the same claim from different producers hashes the same and gets the same checks', async () => {
  const a = await run({ ...claim(), model: 'm1', rationale: 'x', verified: true }, { [OWN]: GENUINE })
  const b = await run({ ...claim(), producer: { model: 'm2', provider: 'p' }, verified: false, review_reason: 'held' }, { [OWN]: GENUINE })
  assert.equal(a.record.claim_hash, b.record.claim_hash)
  assert.deepEqual(a.record.checks, b.record.checks)
  assert.equal(blindClaim(claim()).claimHash, a.record.claim_hash)
})

test('former employee: named with the title but as a former holder -> fail', async () => {
  const team = 'https://harborledger.example/team'
  for (const line of ['Former Chief Revenue Officer Priya Raman left the company in 2025.', 'Priya Raman, ex-Chief Revenue Officer of Harbor Ledger Analytics, now advises startups.', 'Priya Raman was Chief Revenue Officer until 2025.']) {
    const { record } = await run(claim({ person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: team } }), { [OWN]: GENUINE, [team]: page(`<p>Harbor Ledger Analytics team.</p><p>${line}</p>`) })
    assert.deepEqual(status(record, 'person_current'), ['fail'], line)
  }
})

test('generic recruiting inbox: careers+london@, jobs@ and talent.acquisition@ fail; hrishi@ and jobsworth@ pass that check', async () => {
  for (const [email, want] of [['careers+london@harborledger.example', 'fail'], ['jobs@harborledger.example', 'fail'], ['talent.acquisition@harborledger.example', 'fail'], ['hrishi@harborledger.example', 'pass'], ['jobsworth@harborledger.example', 'pass']] as const) {
    const html = GENUINE.replace('priya.raman@harborledger.example</a>', `${email}</a>`)
    const { record } = await run(claim({ contact: { email, source_url: OWN } }), { [OWN]: html })
    assert.deepEqual(status(record, 'contact_not_recruiting'), [want], email)
    assert.deepEqual(status(record, 'contact_on_source'), ['pass'], email)
  }
})

test('contact provenance: an address not printed on its cited source, or off the company domain, fails', async () => {
  const { record: off } = await run(claim({ contact: { email: 'priya@gmail.example', source_url: OWN } }), { [OWN]: GENUINE })
  assert.deepEqual(status(off, 'contact_domain'), ['fail'])
  assert.deepEqual(status(off, 'contact_on_source'), ['fail'])
})

test('future events: a date after as_of fails; an announcement of a past day is unknown, not pass', async () => {
  const fut = await run(claim({ event: { date: '2026-11-20', source_url: OWN }, person: null, contact: null }),
    { [OWN]: page('<p>Harbor Ledger Analytics will open its London office on November 20, 2026. "We are hiring our first sales team in London," it said.</p>') })
  assert.deepEqual(status(fut.record, 'event_date_on_source'), ['fail'])
  assert.equal(fut.record.action, 'skip')
  const ann = await run(claim({ person: null, contact: null }),
    { [OWN]: page('<p>Harbor Ledger Analytics will open its London office on October 20, 2026. "We are hiring our first sales team in London," it said.</p>') })
  assert.deepEqual(status(ann.record, 'event_date_on_source'), ['unknown'])
  assert.equal(ann.record.action, 'hold')
})

test('conflicting sources: a second source dating the event differently -> not pass (held)', async () => {
  const s1 = 'https://alpha-news.example/harbor', s2 = 'https://beta-wire.example/harbor'
  const { record } = await run(claim({ event: { date: '2026-10-20', source_url: s1, corroborating_urls: [s2] }, quotes: [{ text: 'opened its London office', source_url: s1 }], person: null, contact: null }), {
    [s1]: page('<p>Harbor Ledger Analytics (harborledger.example) opened its London office on October 20, 2026.</p>'),
    [s2]: page('<p>Harbor Ledger Analytics opened its London office on September 2, 2026, the company said.</p>'),
  })
  assert.deepEqual(status(record, 'sources_agree'), ['unknown'])
  assert.notEqual(record.verdict, 'pass')
})

test('provenance: syndicated copies of one article are one origin; two different articles confirm independently', async () => {
  const s1 = 'https://alpha-news.example/harbor', s2 = 'https://beta-wire.example/syndicated/harbor', s3 = 'https://gamma-times.example/harbor-london'
  const story = '<p>Harbor Ledger Analytics (harborledger.example) opened its London office on October 20, 2026, adding a sales floor for forty people near Old Street and a training room for new analysts.</p>'
  const base = claim({ quotes: [{ text: 'opened its London office', source_url: s1 }], person: null, contact: null })
  const copies = await run({ ...base, event: { date: '2026-10-20', source_url: s1, corroborating_urls: [s2] } }, { [s1]: page(story), [s2]: page(`<div>Syndicated.</div>${story}`) })
  assert.equal(copies.record.provenance.length, 1)
  assert.deepEqual(status(copies.record, 'independent_confirmation'), ['unknown'])
  const canon = await run({ ...base, event: { date: '2026-10-20', source_url: s1, corroborating_urls: [s3] } },
    { [s1]: page(story), [s3]: page('<p>Different words: Harbor Ledger Analytics said on October 20, 2026 that London is now open.</p>', `<link rel="canonical" href="${s1}">`) })
  assert.equal(canon.record.provenance.length, 1, 'a page declaring the other as canonical is the same document')
  const two = await run({ ...base, event: { date: '2026-10-20', source_url: s1, corroborating_urls: [s3] } },
    { [s1]: page(story), [s3]: page('<p>Analytics firm Harbor Ledger Analytics cut the ribbon in London on October 20, 2026, its chief executive told reporters.</p>') })
  assert.equal(two.record.provenance.length, 2)
  assert.deepEqual(status(two.record, 'independent_confirmation'), ['pass'])
  assert.equal(two.record.verdict, 'pass')
})

const judge = (answers: ('yes' | 'no' | 'unclear' | 'hang' | 'throw')[], model = 'evaluator-model'): Judge & { calls: number } => {
  const j = { id: 'stub-judge', model, calls: 0, async ask() { const a = answers[j.calls++] ?? 'unclear'; if (a === 'hang') return new Promise(() => {}); if (a === 'throw') throw new Error('provider down'); return { answer: a, cost_usd: 0.001 } } } as Judge & { calls: number }
  return j
}
const PRED = { predicates: [{ text: 'is hiring a sales team', source_url: OWN }] }

test('semantic predicate: two agreeing judge answers decide; timeout or disagreement is unknown after bounded retries', async () => {
  const yes = judge(['yes', 'yes'])
  assert.deepEqual(status((await run(claim(PRED), { [OWN]: GENUINE }, { judge: yes })).record, 'predicate_judged'), ['pass']); assert.equal(yes.calls, 2)
  assert.deepEqual(status((await run(claim(PRED), { [OWN]: GENUINE }, { judge: judge(['no', 'no']) })).record, 'predicate_judged'), ['fail'])
  const split = judge(['yes', 'no', 'yes'])
  const d = (await run(claim(PRED), { [OWN]: GENUINE }, { judge: split })).record
  assert.deepEqual(status(d, 'predicate_judged'), ['unknown']); assert.equal(d.action, 'hold')
  const hang = judge(['hang', 'hang', 'hang', 'yes'])
  const t = (await run(claim(PRED), { [OWN]: GENUINE }, { judge: hang })).record
  assert.deepEqual(status(t, 'predicate_judged'), ['unknown']); assert.equal(hang.calls, 3, 'retried within JUDGE_ATTEMPTS, then stopped'); assert.equal(t.action, 'hold')
  const flaky = judge(['throw', 'yes', 'yes'])
  assert.deepEqual(status((await run(claim(PRED), { [OWN]: GENUINE }, { judge: flaky })).record, 'predicate_judged'), ['pass'])
  assert.deepEqual(status((await run(claim(PRED), { [OWN]: GENUINE }, { judge: null })).record, 'predicate_judged'), ['unknown'])
})

test('the judge must be separately configured: the producer\'s own model is refused and never called', async () => {
  const same = judge(['yes', 'yes'], 'Producer-Model-X')
  const { record } = await run({ ...claim(PRED), model: 'producer-model-x' }, { [OWN]: GENUINE }, { judge: same })
  assert.equal(same.calls, 0)
  assert.deepEqual(status(record, 'predicate_judged'), ['unknown'])
  assert.equal(record.judge?.independent, false)
})

test('fetch timeout / error: retried within bounds, then unknown -> hold; replay needs no network', async () => {
  const f = stub({ [OWN]: 'hang' })
  const { record } = await verifyClaim(claim(), { tenantId: A, asOf: AS_OF, now: () => NOW, db: store(), fetchSource: f, fetchTimeoutMs: 20 })
  assert.equal(f.calls.length, 2)
  assert.equal(record.sources[0].outcome, 'timeout')
  assert.equal(record.verdict, 'unknown'); assert.equal(record.action, 'hold')
  assert.equal(record.checks.some(c => c.status === 'fail'), false, 'an unreadable source is never a fail')
  assert.equal(replayRecord(record).same, true)
})

test('authorized sources only: a LinkedIn citation is never fetched and is unknown', async () => {
  const li = 'https://www.linkedin.com/in/synthetic-person'
  const f = stub({ [OWN]: GENUINE, [li]: page('<p>Priya Raman Chief Revenue Officer Harbor Ledger Analytics</p>') })
  const { record } = await verifyClaim(claim({ person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: li } }), { tenantId: A, asOf: AS_OF, now: () => NOW, db: store(), fetchSource: f })
  assert.deepEqual(f.calls, [OWN])
  assert.deepEqual(status(record, 'person_current'), ['unknown'])
  assert.equal(record.action, 'hold')
})

test('malformed or incomplete claims are never pass: impossible day fails, missing parts are unknown', async () => {
  assert.equal((await run(claim({ event: { date: '2026-02-30', source_url: OWN } }), { [OWN]: GENUINE })).record.verdict, 'fail')
  const { record } = await run(claim({ quotes: [], place: undefined }), { [OWN]: GENUINE })
  assert.deepEqual(status(record, 'claim_well_formed'), ['unknown'])
  assert.equal(record.action, 'hold')
  assert.equal((await run('not a claim', {})).record.verdict, 'unknown')
})

test('run budget: the fetch cap stops fetching and the uncapped sources are unknown', async () => {
  const urls = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']
  const f = stub(Object.fromEntries([[OWN, GENUINE], ...urls.map(u => [u, GENUINE])]))
  const { record } = await verifyClaim(claim({ event: { date: '2026-10-20', source_url: OWN, corroborating_urls: urls } }), { tenantId: A, asOf: AS_OF, now: () => NOW, db: store(), fetchSource: f, budget: { maxFetches: 2 } })
  assert.equal(f.calls.length, 2)
  assert.equal(record.budget.fetches, 2)
  assert.deepEqual(record.sources.map(s => s.outcome), ['ok', 'ok', 'budget', 'budget'])
  assert.equal(record.action, 'hold')
})

bothEngines('durable record: stored once per run, final once done, readable only by its own tenant', async c => {
  const { record } = await verifyClaim(claim(), { tenantId: A, asOf: AS_OF, now: () => NOW, db: c.db, fetchSource: stub({ [OWN]: GENUINE }) })
  const got = await getVerdict(c.db, A, record.run_id)
  assert.equal(got?.state, 'done'); assert.equal(got?.verdict, 'pass'); assert.equal(got?.action, 'accept')
  assert.deepEqual(got?.record, record)
  assert.equal(replayRecord(got!.record!).same, true)
  assert.equal(await getVerdict(c.db, B, record.run_id), null, 'another tenant cannot read it')
  assert.deepEqual(await listVerdicts(c.db, B), [])
  assert.equal((await listVerdicts(c.db, A, { claimHash: record.claim_hash })).length, 1)
  await assert.rejects(c.db.run("UPDATE evidence_verdicts SET verdict = 'fail' WHERE id = ?", [record.run_id]), /final once done/)
  await assert.rejects(c.db.run("UPDATE evidence_verdicts SET state = 'running' WHERE id = ?", [record.run_id]), /final once done/)
})

bothEngines('evaluator budget: daily caps are per tenant, durable and separate from the producer\'s', async c => {
  const o = { asOf: AS_OF, now: () => NOW, db: c.db, fetchSource: stub({ [OWN]: GENUINE }), budget: { dailyRuns: 2 } }
  assert.equal((await verifyClaim(claim(), { ...o, tenantId: A })).persisted, true)
  assert.equal((await verifyClaim(claim(), { ...o, tenantId: A })).persisted, true)
  const refused = await verifyClaim(claim(), { ...o, tenantId: A })
  assert.equal(refused.persisted, false); assert.equal(refused.record.verdict, 'unknown'); assert.equal(refused.record.action, 'hold')
  assert.match(refused.record.budget.refused ?? '', /daily run cap/)
  assert.equal((await verifyClaim(claim(), { ...o, tenantId: B })).persisted, true, 'tenant B has its own budget')
  assert.equal((await verifyClaim(claim(), { ...o, tenantId: A, now: () => NOW + 86_400_000 })).persisted, true, 'a new day has a new budget')
  // Concurrent runs reserve their whole cap first: with room for one reservation, only one of two overlapping runs starts.
  // The fetch is slow, so each run still holds its reservation (not its actual $0) while the other one reserves.
  const slow = stub({ [OWN]: GENUINE })
  const slowFetch: SourceFetcher = async (u, s) => { await new Promise(r => setTimeout(r, 400)); return slow(u, s) }
  const usd = { asOf: AS_OF, now: () => NOW, db: c.db, fetchSource: slowFetch, fetchTimeoutMs: 5_000, budget: { maxRunUsd: 0.05, dailyUsd: 0.08 } }
  const both = await Promise.all([verifyClaim(claim(), { ...usd, tenantId: 'tenant-verifier-cccc' }), verifyClaim(claim(), { ...usd, tenantId: 'tenant-verifier-cccc' })])
  assert.deepEqual(both.map(r => r.persisted).sort(), [false, true])
  for (const t of ['trial_reservations', 'tenant_spend_pools', 'scan_model_calls']) {
    assert.equal(Number((await c.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))?.n), 0, `${t}: the evaluator never draws on producer budgets`)
  }
}, { pgMax: 4 })
