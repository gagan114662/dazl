// #1037 (named contact on held leads): the people search also covers leads held for review, after every ready lead and
// inside the same cap, and the run report says what the pass did (eligible, searched, results, refusals by cause).
//
// Fixtures (helpers/people-held-fixture.ts) keep the SHAPE of a staging run seen on 2026-11-13 (16 leads, 2 ready): its review reasons, fit grades, scores, buyer roles and title wording. Companies, people and profile URLs are invented;
// the result line shape "Name - Title - Employer | LinkedIn" is the one the parser accepts. TinyFish is stubbed: no network, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { leadPerson } from '../lib/people/lead-person.ts'
import { findPeople, MAX_COMPANIES } from '../lib/people/people-search.ts'
import { HELD_ICP as ICP, HELD_WHO as WHO, HELD_RESULTS as RESULTS, env, setup, stub, type Row } from './helpers/people-held-fixture.ts'
import { runFixture, type Fixture } from './helpers/acceptance-harness.ts'

// The counts object the pass fills (people-search.ts PeopleStats), written out so this file needs nothing the fix added.
const newPeopleStats = () => ({ eligible: 0, held: 0, already_named: 0, searched: 0, results: 0, profiles: 0, refused: {} as Record<string, number>, failed: {} as Record<string, number> })
const people = (db: Database.Database) => db.prepare("SELECT l.company, l.review_reason, e.value, e.source_url FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id WHERE e.connector = 'search:people' AND e.kind = 'person' ORDER BY e.insert_seq").all() as { company: string; review_reason: string | null; value: string; source_url: string }[]

// 2 ready, the rest held BEFORE the search, by reasons real scans produce most: quote_unconfirmed, blocked_by_site, needs_javascript.
const JOB: Row[] = [
  ['L-corvane', 'Corvane', 'quote_unconfirmed', 95],
  ['L-pagewake', 'Pagewake', 'quote_unconfirmed', 90],
  ['L-meshgate', 'Meshgate', 'blocked_by_site', 85],
  ['L-helpwell', 'Helpwell', 'needs_javascript', 60],
  ['L-freightwise', 'Freightwise', null, 40],
  ['L-surveyhive', 'Surveyhive', null, 30],
]

test('#1037 held leads: a lead held for review gets a people search too, and its row names the person (Pagewake: Marta Solberg, Regional Sales Director)', async () => {
  const { db, job } = setup(JOB); const s = stub(); const stats = newPeopleStats()
  const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats })
  assert.equal(n, 4, 'Ewan C. Tomas (ready Surveyhive) + Marta Solberg, Anya Braun (held Pagewake) + Anders Smed (held Meshgate)')
  assert.deepEqual(people(db).filter(p => p.review_reason !== null).map(p => [p.company, p.review_reason, p.value, p.source_url]), [
    ['Pagewake', 'quote_unconfirmed', 'Marta Solberg, Regional Sales Director', 'https://www.linkedin.com/in/marta-solberg-test'],
    ['Pagewake', 'quote_unconfirmed', 'Anya Braun, Strategic Partner Sales Manager', 'https://www.linkedin.com/in/anya-braun-test'],
    ['Meshgate', 'blocked_by_site', 'Anders Smed, VP of Sales Development & PG', 'https://www.linkedin.com/in/anders-smed-test'],
  ])
  // The row rule (the same one the Leads page renders with) now names the held lead's person, LinkedIn link included.
  const row = (id: string) => leadPerson(db.prepare("SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind IN ('person','contact') ORDER BY insert_seq").all(id), WHO.join('; '))
  assert.deepEqual(row('L-pagewake'), { name: 'Marta Solberg', title: 'Regional Sales Director', linkedin: 'https://www.linkedin.com/in/marta-solberg-test', source: null, via: 'a public LinkedIn search result (not verified as current)', current: false })
  assert.equal(row('L-meshgate')?.name, 'Anders Smed'); assert.equal(row('L-meshgate')?.linkedin, 'https://www.linkedin.com/in/anders-smed-test')
  assert.equal(row('L-corvane'), null, 'searched, nobody found: the row reads "No buyer named yet"')
  // A person on a held row never releases the hold.
  assert.equal((db.prepare("SELECT review_reason FROM leads WHERE id = 'L-pagewake'").get() as { review_reason: string }).review_reason, 'quote_unconfirmed')
})

test('#1037 held leads: ready leads are searched first whatever their score, and held ones only take what is left of the SAME cap', async () => {
  const { db, job } = setup(JOB); const s = stub()
  await findPeople(db, 'A', job, { env, fetchImpl: s.f })
  assert.equal(MAX_COMPANIES, 5)
  assert.deepEqual(s.companies, ['Freightwise', 'Surveyhive', 'Corvane', 'Pagewake', 'Meshgate'], 'ready first (by score), then held by score; Helpwell is the sixth lead and gets no search: the cap is still 5')
  // A cap of 2 is used up by the two ready leads: no held lead is searched.
  { const { db, job } = setup(JOB); const s = stub(); await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 2, skipNamed: true }); assert.deepEqual(s.companies, ['Freightwise', 'Surveyhive']) }
  // The operator's own per-scan limit still binds the whole pass.
  { const { db, job } = setup(JOB); const s = stub(); await findPeople(db, 'A', job, { env: { ...env, TINYFISH_SEARCHES_PER_SCAN: '3' }, fetchImpl: s.f }); assert.deepEqual(s.companies, ['Freightwise', 'Surveyhive', 'Corvane']) }
})

// That run's 16 leads by review_reason, fit and score. Its 7 fit-0 leads were graded out of the list before the search and are hidden
// on the page, yet they took all 5 searches; the 9 rows the page shows got none.
const RUN_SHAPE: Row[] = [
  ['r01', 'Arden Systems', 'needs_javascript', 95], ['r02', 'Helpwell', 'needs_javascript', 95], ['r03', 'Suds Ledger POS', 'quote_unconfirmed', 90],
  ['r04', 'Voxline US Inc.', 'quote_unconfirmed', 90], ['r05', 'Tallyworks', 'needs_javascript', 90], ['r06', 'Corvane', 'quote_unconfirmed', 90],
  ['r07', 'Payrollo', 'needs_javascript', 85], ['r08', 'Deskflow', 'quote_unconfirmed', 85], ['r09', 'Freightwise', null, 80, false, 0],
  ['r10', 'Zaplink', 'quote_unconfirmed', 75], ['r11', 'Surveyhive', null, 55, false, 0], ['r12', 'Pagewake', 'no_sales_hiring_evidence', 49, false, 0],
  ['r13', 'Meshgate', 'no_sales_hiring_evidence', 49, false, 0], ['r14', 'Sitebelt', 'no_sales_hiring_evidence', 49, false, 0],
  ['r15', 'Tracewell', 'no_sales_hiring_evidence', 49, false, 0], ['r16', 'Boardlane', 'no_sales_hiring_evidence', 49, false, 0],
]
test('#1037 a run shaped like the staging one: no search goes to a lead graded out of the list (fit 0-1, hidden); the rows the page shows get the searches', async () => {
  const { db, job } = setup(RUN_SHAPE); const s = stub(); const stats = newPeopleStats()
  await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats })
  assert.deepEqual(s.companies, ['Arden Systems', 'Helpwell', 'Suds Ledger POS', 'Voxline US Inc.', 'Tallyworks'], 'the five best visible rows; none of the 7 hidden leads')
  assert.equal(stats.eligible, 9, 'the 9 rows /api/leads returns for this job (hidden_count 7)'); assert.equal(stats.held, 9)
  // A graded-in ready lead still goes first.
  { const { db, job } = setup([...RUN_SHAPE, ['r17', 'Freightwise Cargo', null, 10, false, 4]]); const s = stub(); await findPeople(db, 'A', job, { env, fetchImpl: s.f })
    assert.equal(s.companies[0], 'Freightwise Cargo'); assert.equal(s.companies.length, 5) }
  // fit 2 is in the list (only 0-1 is hidden); fit 1 is not.
  { const { db, job } = setup([['a', 'Meshgate', null, 50, false, 2], ['b', 'Corvane', null, 60, false, 1]]); const s = stub(); await findPeople(db, 'A', job, { env, fetchImpl: s.f }); assert.deepEqual(s.companies, ['Meshgate']) }
})

test('#1037 held leads: a hold that puts the company itself in doubt, an unknown reason and a rejected lead get no search', async () => {
  const rows: Row[] = [
    ['L1', 'Meshgate', 'counterparty_signal', 90],        // named as someone else's customer
    ['L2', 'Pagewake', 'location_mismatch', 90],     // possibly a same-name business elsewhere
    ['L3', 'Surveyhive', 'location_unconfirmed', 90],
    ['L4', 'Corvane', 'self_description', 90],
    ['L5', 'Helpwell', 'first_party_signal', 90],
    ['L6', 'Freightwise', 'some_future_reason', 90],     // not on the list: fail closed
    ['L7', 'Boardlane', 'quote_unconfirmed', 90, true], // rejected by the user
    ['L9', 'Suds Ledger POS', 'trial_budget_reached', 90], // a budget-stopped free scan may hold candidates whose company was never checked
    ['L8', 'Tracewell', 'outside_window_undated', 10],
  ]
  const { db, job } = setup(rows); const s = stub(); const stats = newPeopleStats()
  await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats })
  assert.deepEqual(s.companies, ['Tracewell'])
  assert.equal(stats.eligible, 1); assert.equal(stats.held, 1)
})

test('#1037 held leads: another tenant\'s job id searches nothing (job ownership is checked before any lead is read)', async () => {
  const { db, job } = setup(JOB); const s = stub(); const stats = newPeopleStats()
  assert.equal(await findPeople(db, 'B', job, { env, fetchImpl: s.f, stats }), 0)
  assert.deepEqual(s.companies, []); assert.equal(people(db).length, 0)
})

// ---- through the real runJob: a scan whose only candidate is held still looks up its person, and the report counts it ----
const REQUEST = 'Find B2B software companies hiring account executives within the past 90 days.'
const RICP = { ...ICP, signals: ['Hiring account executives'], country: 'US', language: 'en', window_days: 90 }
const SRC = 'https://news.example.test/pagewake-hiring'
const QUOTE = 'Pagewake is hiring account executives across its enterprise sales team'
// No date anywhere on the page and none claimed: the candidate is held `outside_window_undated` (3 of the matrix's held rows).
const page = { title: 'Pagewake grows its sales team', text: `${QUOTE}. ${'More about the company and its sales organisation. '.repeat(15)}` }
function fx(queries: string[], over: Partial<Fixture> = {}): Fixture {
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const s = String(u)
    if (s.startsWith('https://api.search.tinyfish.ai') && (new URL(s).searchParams.get('query') ?? '').startsWith('site:linkedin.com/in ')) {
      queries.push(new URL(s).searchParams.get('query')!)
      return new Response(JSON.stringify({ results: RESULTS.Pagewake }), { status: 200 })
    }
    return globalThis.fetch(u, init)
  }) as typeof fetch
  return { request: REQUEST, modelIcp: RICP, modelQueries: ['B2B software hiring account executives'], hits: [{ url: SRC, title: page.title, snippet: QUOTE, date: null }], tfPages: { [SRC]: page }, own: { [SRC]: page },
    extraction: [{ company: 'Pagewake', signal: 'hiring account executives', source_url: SRC, excerpt: QUOTE, event_date: null }], deps: { fetchImpl }, ...over }
}
const stage = (r: Awaited<ReturnType<typeof runFixture>>) => {
  const rep = JSON.parse((r.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { enrichment: { stage: string; status: string; reason: string | null; detail?: Record<string, unknown> }[] }
  return rep.enrichment.find(x => x.stage === 'people_search')
}

test('#1037 THROUGH THE RUNNER: a scan whose only lead is held for review still names its person, and the run report counts the search', async () => {
  const queries: string[] = []
  const r = await runFixture(fx(queries))
  const lead = r.db.prepare("SELECT id, review_reason FROM leads WHERE company = 'Pagewake'").get() as { id: string; review_reason: string | null } | undefined
  assert.ok(lead, 'the candidate was kept'); assert.ok(lead!.review_reason, `it is held for review (${lead!.review_reason}), not ready`)
  assert.equal(queries.length, 1, 'one people search ran for the held lead'); assert.match(queries[0], /^site:linkedin\.com\/in "Pagewake" \("Account Executive" OR "Sales Manager" OR "VP Sales"\)$/)
  const st = stage(r)
  assert.equal(st?.status, 'ok', JSON.stringify(st))
  assert.deepEqual(st?.detail, { people_stored: 2, eligible: 1, held_eligible: 1, searched: 1, results: 2, profile_results: 2 })
  const p = leadPerson(r.db.prepare("SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind IN ('person','contact')").all(lead!.id), WHO.join('; '))
  assert.equal(p?.name, 'Marta Solberg'); assert.equal(p?.title, 'Regional Sales Director'); assert.equal(p?.linkedin, 'https://www.linkedin.com/in/marta-solberg-test')
  assert.ok((r.db.prepare("SELECT review_reason FROM leads WHERE id = ?").get(lead!.id) as { review_reason: string | null }).review_reason, 'the hold stands: a named person does not make the lead ready')
})

const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-test-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_ENABLED: '1', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.01', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' }
async function withEnv<T>(e: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(e).map(k => [k, process.env[k]]))
  Object.assign(process.env, e)
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const reserved = (r: Awaited<ReturnType<typeof runFixture>>) => (r.db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs').get() as { s: number | null }).s ?? 0

test('#1037 THROUGH THE RUNNER, free trial: the held lead\'s one search is reserved from the trial reserve before it runs (one search price, inside the reserve)', async () => {
  const queries: string[] = [], control: string[] = []
  const t = await withEnv(TRIAL_ENV, () => runFixture(fx(queries, { fundedBy: 'trial', model: 'claude-sonnet-4-5' })))
  const off = await withEnv({ ...TRIAL_ENV, DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '0' }, () => runFixture(fx(control, { fundedBy: 'trial', model: 'claude-sonnet-4-5' })))
  const lead = t.db.prepare("SELECT review_reason FROM leads WHERE company = 'Pagewake'").get() as { review_reason: string | null } | undefined
  assert.ok(lead?.review_reason, 'held for review on the trial scan too')
  assert.equal(queries.length, 1); assert.equal(control.length, 0)
  assert.equal(stage(t)?.status, 'ok', JSON.stringify(stage(t)))
  assert.ok(Math.abs((reserved(t) - reserved(off)) - 0.01) < 1e-9, `exactly one search price reserved for the held lead's search (${reserved(t)} vs ${reserved(off)})`)
  assert.ok(reserved(t) <= 1, 'inside the trial reserve')
})
