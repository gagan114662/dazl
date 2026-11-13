// #1037 (named contact on held leads): the people search also covers leads held for review, after every ready lead and
// inside the same cap, and the run report says what the pass did (eligible, searched, results, refusals by cause).
//
// Built from real staging data, read through the ops door on 2026-11-13 (no scan run): job 13808d9c6e6e7a792f625d58
// ("B2B software companies hiring account executives", 16 leads). Companies, review reasons, people, titles and profile
// URLs below are that job's stored rows; the result line shape "Name - Title - Employer | LinkedIn" is the one the parser
// accepted when it stored them (the raw search answers are not kept). TinyFish is stubbed: no network, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { leadPerson } from '../lib/people/lead-person.ts'
import { findPeople, MAX_COMPANIES } from '../lib/people/people-search.ts'
import { REAL_ICP as ICP, REAL_WHO as WHO, REAL_RESULTS as RESULTS, env, setup, stub, type Row } from './helpers/people-real-13808d9c.ts'
import { runFixture, type Fixture } from './helpers/acceptance-harness.ts'

// The counts object the pass fills (people-search.ts PeopleStats), written out so this file needs nothing the fix added.
const newPeopleStats = () => ({ eligible: 0, held: 0, already_named: 0, searched: 0, results: 0, profiles: 0, refused: {} as Record<string, number> })
const people = (db: Database.Database) => db.prepare("SELECT l.company, l.review_reason, e.value, e.source_url FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id WHERE e.connector = 'search:people' AND e.kind = 'person' ORDER BY e.insert_seq").all() as { company: string; review_reason: string | null; value: string; source_url: string }[]

// Job 13808d9c as it stands: 2 ready, the rest held. (PagerDuty and Kong were held by the later sales-hiring gate there; here they
// are held BEFORE the search, by reasons the 8 matrix scans produced: quote_unconfirmed, blocked_by_site, outside_window_undated.)
const JOB: Row[] = [
  ['L-cisco', 'Cisco', 'quote_unconfirmed', 95],
  ['L-pagerduty', 'PagerDuty', 'quote_unconfirmed', 90],
  ['L-kong', 'Kong', 'blocked_by_site', 85],
  ['L-zendesk', 'Zendesk', 'needs_javascript', 60],
  ['L-flexport', 'Flexport', null, 40],
  ['L-qualtrics', 'Qualtrics', null, 30],
]

test('#1037 held leads: a lead held for review gets a people search too, and its row names the person (PagerDuty: Mark Sarman, Regional Sales Director)', async () => {
  const { db, job } = setup(JOB); const s = stub(); const stats = newPeopleStats()
  const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats })
  assert.equal(n, 4, 'Evan C. Thomas (ready Qualtrics) + Mark Sarman, Anna Brown (held PagerDuty) + Andy Smit (held Kong)')
  assert.deepEqual(people(db).filter(p => p.review_reason !== null).map(p => [p.company, p.review_reason, p.value, p.source_url]), [
    ['PagerDuty', 'quote_unconfirmed', 'Mark Sarman, Regional Sales Director', 'https://www.linkedin.com/in/marksarman'],
    ['PagerDuty', 'quote_unconfirmed', 'Anna Brown, Strategic Partner Sales Manager', 'https://www.linkedin.com/in/annacbrown'],
    ['Kong', 'blocked_by_site', 'Andy Smit, VP of Sales Development & PG', 'https://www.linkedin.com/in/andysmit'],
  ])
  // The row rule (the same one the Leads page renders with) now names the held lead's person, LinkedIn link included.
  const row = (id: string) => leadPerson(db.prepare("SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind IN ('person','contact') ORDER BY insert_seq").all(id), WHO.join('; '))
  assert.deepEqual(row('L-pagerduty'), { name: 'Mark Sarman', title: 'Regional Sales Director', linkedin: 'https://www.linkedin.com/in/marksarman', source: null, via: 'a public LinkedIn search result (not verified as current)', current: false })
  assert.equal(row('L-kong')?.name, 'Andy Smit'); assert.equal(row('L-kong')?.linkedin, 'https://www.linkedin.com/in/andysmit')
  assert.equal(row('L-cisco'), null, 'searched, nobody found: the row reads "No buyer named yet"')
  // A person on a held row never releases the hold.
  assert.equal((db.prepare("SELECT review_reason FROM leads WHERE id = 'L-pagerduty'").get() as { review_reason: string }).review_reason, 'quote_unconfirmed')
})

test('#1037 held leads: ready leads are searched first whatever their score, and held ones only take what is left of the SAME cap', async () => {
  const { db, job } = setup(JOB); const s = stub()
  await findPeople(db, 'A', job, { env, fetchImpl: s.f })
  assert.equal(MAX_COMPANIES, 5)
  assert.deepEqual(s.companies, ['Flexport', 'Qualtrics', 'Cisco', 'PagerDuty', 'Kong'], 'ready first (by score), then held by score; Zendesk is the sixth lead and gets no search: the cap is still 5')
  // A cap of 2 is used up by the two ready leads: no held lead is searched.
  { const { db, job } = setup(JOB); const s = stub(); await findPeople(db, 'A', job, { env, fetchImpl: s.f, maxCompanies: 2, skipNamed: true }); assert.deepEqual(s.companies, ['Flexport', 'Qualtrics']) }
  // The operator's own per-scan limit still binds the whole pass.
  { const { db, job } = setup(JOB); const s = stub(); await findPeople(db, 'A', job, { env: { ...env, TINYFISH_SEARCHES_PER_SCAN: '3' }, fetchImpl: s.f }); assert.deepEqual(s.companies, ['Flexport', 'Qualtrics', 'Cisco']) }
})

// The real job's 16 leads exactly as staging holds them now (company, review_reason, fit, score). Its 5 searches went to Flexport,
// Qualtrics, PagerDuty, Kong and one more: all graded fit 0 by the buyer-fit check afterwards and hidden. The 9 rows the page shows got none.
const REAL_13808D9C: Row[] = [
  ['r01', 'Salesforce', 'needs_javascript', 95], ['r02', 'Zendesk', 'needs_javascript', 95], ['r03', 'Wash-Dry-Fold POS', 'quote_unconfirmed', 90],
  ['r04', 'Luware US Inc.', 'quote_unconfirmed', 90], ['r05', 'Alteryx', 'needs_javascript', 90], ['r06', 'Cisco', 'quote_unconfirmed', 90],
  ['r07', 'Deel', 'needs_javascript', 85], ['r08', 'ServiceNow', 'quote_unconfirmed', 85], ['r09', 'Flexport', null, 80, false, 0],
  ['r10', 'Zapier', 'quote_unconfirmed', 75], ['r11', 'Qualtrics', null, 55, false, 0], ['r12', 'PagerDuty', 'no_sales_hiring_evidence', 49, false, 0],
  ['r13', 'Kong', 'no_sales_hiring_evidence', 49, false, 0], ['r14', 'Geniebelt', 'no_sales_hiring_evidence', 49, false, 0],
  ['r15', 'Dynatrace', 'no_sales_hiring_evidence', 49, false, 0], ['r16', 'Atlassian', 'no_sales_hiring_evidence', 49, false, 0],
]
test('#1037 real job 13808d9c: no search goes to a lead graded out of the list (fit 0-1, hidden); the rows the page shows get the searches', async () => {
  const { db, job } = setup(REAL_13808D9C); const s = stub(); const stats = newPeopleStats()
  await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats })
  assert.deepEqual(s.companies, ['Salesforce', 'Zendesk', 'Wash-Dry-Fold POS', 'Luware US Inc.', 'Alteryx'], 'the five best visible rows; none of the 7 hidden leads')
  assert.equal(stats.eligible, 9, 'the 9 rows /api/leads returns for this job (hidden_count 7)'); assert.equal(stats.held, 9)
  // A graded-in ready lead still goes first.
  { const { db, job } = setup([...REAL_13808D9C, ['r17', 'Flexport Freight', null, 10, false, 4]]); const s = stub(); await findPeople(db, 'A', job, { env, fetchImpl: s.f })
    assert.equal(s.companies[0], 'Flexport Freight'); assert.equal(s.companies.length, 5) }
  // fit 2 is in the list (only 0-1 is hidden); fit 1 is not.
  { const { db, job } = setup([['a', 'Kong', null, 50, false, 2], ['b', 'Cisco', null, 60, false, 1]]); const s = stub(); await findPeople(db, 'A', job, { env, fetchImpl: s.f }); assert.deepEqual(s.companies, ['Kong']) }
})

test('#1037 held leads: a hold that puts the company itself in doubt, an unknown reason and a rejected lead get no search', async () => {
  const rows: Row[] = [
    ['L1', 'Kong', 'counterparty_signal', 90],        // named as someone else's customer
    ['L2', 'PagerDuty', 'location_mismatch', 90],     // possibly a same-name business elsewhere
    ['L3', 'Qualtrics', 'location_unconfirmed', 90],
    ['L4', 'Cisco', 'self_description', 90],
    ['L5', 'Zendesk', 'first_party_signal', 90],
    ['L6', 'Flexport', 'some_future_reason', 90],     // not on the list: fail closed
    ['L7', 'Atlassian', 'quote_unconfirmed', 90, true], // rejected by the user
    ['L8', 'Dynatrace', 'outside_window_undated', 10],
  ]
  const { db, job } = setup(rows); const s = stub(); const stats = newPeopleStats()
  await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats })
  assert.deepEqual(s.companies, ['Dynatrace'])
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
const SRC = 'https://news.example.test/pagerduty-hiring'
const QUOTE = 'PagerDuty is hiring account executives across its enterprise sales team'
// No date anywhere on the page and none claimed: the candidate is held `outside_window_undated` (3 of the matrix's held rows).
const page = { title: 'PagerDuty grows its sales team', text: `${QUOTE}. ${'More about the company and its sales organisation. '.repeat(15)}` }
function fx(queries: string[], over: Partial<Fixture> = {}): Fixture {
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const s = String(u)
    if (s.startsWith('https://api.search.tinyfish.ai') && (new URL(s).searchParams.get('query') ?? '').startsWith('site:linkedin.com/in ')) {
      queries.push(new URL(s).searchParams.get('query')!)
      return new Response(JSON.stringify({ results: RESULTS.PagerDuty }), { status: 200 })
    }
    return globalThis.fetch(u, init)
  }) as typeof fetch
  return { request: REQUEST, modelIcp: RICP, modelQueries: ['B2B software hiring account executives'], hits: [{ url: SRC, title: page.title, snippet: QUOTE, date: null }], tfPages: { [SRC]: page }, own: { [SRC]: page },
    extraction: [{ company: 'PagerDuty', signal: 'hiring account executives', source_url: SRC, excerpt: QUOTE, event_date: null }], deps: { fetchImpl }, ...over }
}
const stages = (r: Awaited<ReturnType<typeof runFixture>>) => (JSON.parse((r.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { enrichment: { stage: string }[] }).enrichment.map(x => x.stage)
const stage = (r: Awaited<ReturnType<typeof runFixture>>) => {
  const rep = JSON.parse((r.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { enrichment: { stage: string; status: string; reason: string | null; detail?: Record<string, unknown> }[] }
  return rep.enrichment.find(x => x.stage === 'people_search')
}

test('#1037 THROUGH THE RUNNER: a scan whose only lead is held for review still names its person, and the run report counts the search', async () => {
  const queries: string[] = []
  const r = await runFixture(fx(queries))
  const lead = r.db.prepare("SELECT id, review_reason FROM leads WHERE company = 'PagerDuty'").get() as { id: string; review_reason: string | null } | undefined
  assert.ok(lead, 'the candidate was kept'); assert.ok(lead!.review_reason, `it is held for review (${lead!.review_reason}), not ready`)
  assert.equal(queries.length, 1, 'one people search ran for the held lead'); assert.match(queries[0], /^site:linkedin\.com\/in "PagerDuty" \("Account Executive" OR "Sales Manager" OR "VP Sales"\)$/)
  const st = stage(r)
  assert.equal(st?.status, 'ok', JSON.stringify(st))
  // The search runs after the fit and sales-hiring checks (they decide which leads stay on the list), and before the yield record.
  const order = stages(r)
  assert.ok(order.indexOf('people_search') > order.indexOf('buyer_fit') && order.indexOf('buyer_fit') >= 0, order.join(' > '))
  assert.ok(order.indexOf('people_search') > order.indexOf('sales_hiring_gate') && order.indexOf('sales_hiring_gate') >= 0, order.join(' > '))
  assert.deepEqual(st?.detail, { people_stored: 2, eligible: 1, held_eligible: 1, searched: 1, results: 2, profile_results: 2 })
  const p = leadPerson(r.db.prepare("SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind IN ('person','contact')").all(lead!.id), WHO.join('; '))
  assert.equal(p?.name, 'Mark Sarman'); assert.equal(p?.title, 'Regional Sales Director'); assert.equal(p?.linkedin, 'https://www.linkedin.com/in/marksarman')
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
  const lead = t.db.prepare("SELECT review_reason FROM leads WHERE company = 'PagerDuty'").get() as { review_reason: string | null } | undefined
  assert.ok(lead?.review_reason, 'held for review on the trial scan too')
  assert.equal(queries.length, 1); assert.equal(control.length, 0)
  assert.equal(stage(t)?.status, 'ok', JSON.stringify(stage(t)))
  assert.ok(Math.abs((reserved(t) - reserved(off)) - 0.01) < 1e-9, `exactly one search price reserved for the held lead's search (${reserved(t)} vs ${reserved(off)})`)
  assert.ok(reserved(t) <= 1, 'inside the trial reserve')
})
