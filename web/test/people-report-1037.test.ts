// #1037: the run report's people_search stage says what the pass did (eligible, searched, results, refusals by cause), and a pass
// that sent no search never reads as "no profile results". Invented rows in the shape of a staging run (helpers/people-held-fixture.ts);
// TinyFish stubbed: no network, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { tiedLabel } from '../lib/people/company-tie.ts'
import { LABEL, findPeople, newPeopleStats, peopleSearchable, peopleStatsDetail, peopleTraceMessage, profileHit, SEARCHABLE_HOLDS } from '../lib/people/people-search.ts'
import { searchableCompanyCount } from '../lib/people/searchable-holds.ts'
import { companyKey } from '../lib/scan/evidence.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { HELD_ICP as ICP, HELD_RESULTS as RESULTS, env, setup, stub } from './helpers/people-held-fixture.ts'

test('#1037 run report: which holds the pass may search is one fail-closed list', () => {
  for (const r of ['counterparty_signal', 'location_mismatch', 'location_unconfirmed', 'self_description', 'first_party_signal', 'trial_budget_reached', 'some_future_reason', '']) assert.equal(peopleSearchable(r), false, r)
  for (const r of [null, undefined, 'quote_unconfirmed', 'blocked_by_site', 'outside_window_undated', 'needs_javascript', 'no_sales_hiring_evidence']) assert.equal(peopleSearchable(r), true, String(r))
  for (const r of SEARCHABLE_HOLDS) assert.match(r, /^[a-z_]+$/, 'reasons are inlined into SQL: plain identifiers only')
})


test('#1037 run report: the pass counts what it did, with refusals by cause', async () => {
  const { db, job } = setup([['L-pagewake', 'Pagewake', 'quote_unconfirmed', 90], ['L-meshgate', 'Meshgate', null, 50]])
  const s = stub({
    Pagewake: [
      ...RESULTS.Pagewake,
      { url: 'https://www.linkedin.com/company/pagewake', title: 'Pagewake | LinkedIn', snippet: 'Chicago, Illinois, United States' },                                                       // not a profile
      { url: 'https://www.linkedin.com/in/top-reps', title: 'Top 10 sales leaders to follow | LinkedIn', snippet: 'Chicago, Illinois, United States' },                                       // unreadable
      { url: 'https://www.linkedin.com/in/old-hand', title: 'Olga Hand - Former Sales Manager - Pagewake | LinkedIn', snippet: 'Chicago, Illinois, United States' },                          // past role
      { url: 'https://www.linkedin.com/in/rival-rep', title: 'Rita Rival - Sales Manager - Alertbird | LinkedIn', snippet: 'Chicago, Illinois, United States' },                                // other employer
      { url: 'https://www.linkedin.com/in/sre-sam', title: 'Sam Reyes - Site Reliability Engineer - Pagewake | LinkedIn', snippet: 'Chicago, Illinois, United States' },                      // not a buyer role
    ],
    Meshgate: [],
  })
  const stats = newPeopleStats()
  const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats })
  assert.equal(n, 2)
  assert.deepEqual(stats, { eligible: 2, held: 1, already_named: 0, searched: 2, results: 7, profiles: 3, refused: { not_profile: 1, unreadable: 1, past_role: 1, other_employer: 1, role: 1 }, failed: {} })
  assert.deepEqual(peopleStatsDetail(stats), { eligible: 2, held_eligible: 1, searched: 2, results: 7, profile_results: 3, refused_not_profile: 1, refused_unreadable: 1, refused_past_role: 1, refused_other_employer: 1, refused_role: 1 })
  assert.equal(profileHit({ url: 'https://www.linkedin.com/in/rival-rep', title: 'Rita Rival - Sales Manager - Alertbird | LinkedIn', snippet: '', date: null }, 'Pagewake'), 'other_employer')
  assert.deepEqual(profileHit({ url: 'https://www.linkedin.com/in/marta-solberg-test', title: RESULTS.Pagewake[0].title, snippet: '', date: null }, 'Pagewake'), { name: 'Marta Solberg', title: 'Regional Sales Director' })
})

test('#1037 run report: a place refusal is counted (a profile result naming no place, when the request names one)', async () => {
  const { db, job } = setup([['L-meshgate', 'Meshgate', 'blocked_by_site', 50]], { ...ICP, where: ['Chicago, Illinois'] })
  const stats = newPeopleStats()
  const noPlace = stub({ Meshgate: [{ url: 'https://www.linkedin.com/in/anders-smed-test', title: 'Anders Smed - VP of Sales Development & PG - Meshgate | LinkedIn', snippet: 'VP of Sales Development at Meshgate' }] })
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: noPlace.f, stats }), 0)
  assert.deepEqual(stats.refused, { place: 1 }); assert.equal(peopleStatsDetail(stats).refused_place, 1)
})

test('#1037 run report: a pass that sent no search never reads as "no profile results"', async () => {
  // The 8 matrix scans: nothing eligible. Before, the report said "no profile results named a role-matching person at a verified company".
  { const { db, job } = setup([['L1', 'Meshgate', 'counterparty_signal', 90]]); const s = stub(); const stats = newPeopleStats()
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats }), 0)
    assert.equal(peopleTraceMessage(0, null, stats), 'no lead was eligible for a people search (0 searches run)') }
  // First play: every eligible lead already names its person.
  { const { db, job } = setup([['L-meshgate', 'Meshgate', 'blocked_by_site', 50]]); const stats = newPeopleStats()
    addEnrichment(db, 'A', 'L-meshgate', { connector: 'search:people', kind: 'person', value: 'Anders Smed, VP of Sales Development & PG', label: tiedLabel(LABEL, 'place'), confidence: null, source_url: 'https://www.linkedin.com/in/anders-smed-test', source_date: '2026-11-13', retrieved_at: 1 })
    const s = stub(); assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats, maxCompanies: 10, skipNamed: true }), 0)
    assert.deepEqual(s.companies, []); assert.equal(stats.already_named, 1)
    assert.equal(peopleTraceMessage(0, null, stats), 'every eligible lead already names its person (0 searches run)') }
  // Searched and found nobody: the counts are in the sentence.
  { const { db, job } = setup([['L-corvane', 'Corvane', 'quote_unconfirmed', 50]]); const stats = newPeopleStats()
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub().f, stats }), 0)
    assert.equal(peopleTraceMessage(0, null, stats), "1 search(es) run, 0 result(s): none named a role-matching person at the lead's company") }
  // No buyer role in the request: the pass reads no lead, and the message names that cause, not eligibility.
  { const { db, job } = setup([['L-corvane', 'Corvane', null, 50]], { ...ICP, who: [] }); const s = stub(); const stats = newPeopleStats()
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats }), 0); assert.deepEqual(s.companies, [])
    assert.equal(peopleTraceMessage(0, null, stats), 'the request names no buyer role to search for (0 searches run)') }
  // A stop still wins, and a pass that stored someone still has no message.
  const st = { ...newPeopleStats(), eligible: 3, searched: 1, results: 4 }
  assert.match(String(peopleTraceMessage(0, 'quota', st)), /quota is used up/); assert.equal(peopleTraceMessage(2, null, st), null)
  // Malformed counts never throw and never print NaN.
  const bad = { eligible: NaN, held: -1, already_named: 1.5, searched: Infinity, results: '7', profiles: null, refused: { role: -3, place: NaN, __proto__: 5 } } as unknown as ReturnType<typeof newPeopleStats>
  assert.deepEqual(peopleStatsDetail(bad), { eligible: 0, held_eligible: 0, searched: 0, results: 0, profile_results: 0 })
})

test('#1037 free trial: the searches reserved before finish count only the rows the pass will read', () => {
  const rows = [
    { company: 'Pagewake', review_reason: 'quote_unconfirmed' },              // held, searchable: 1
    { company: 'Pagewake Inc.', review_reason: null, fit: 4 },                 // same company key: still 1
    { company: 'Freightwise', review_reason: null, fit: 0 },                   // graded out of the list: reserves nothing
    { company: 'Surveyhive', review_reason: null, fit: 1 },                    // graded out
    { company: 'Meshgate', review_reason: 'counterparty_signal' },            // company in doubt
    { company: 'Tracewell', review_reason: 'trial_budget_reached' },          // a budget-stopped free scan: its company may never have been checked
    { company: '', review_reason: null, fit: 5 },                              // no company to search for
    { company: 'Corvane', fit: 2 },                                            // ready (no reason), fit 2 is on the list: 2
    { company: 'Helpwell', review_reason: 'some_future_reason' },             // unknown hold: fail closed
    { company: 5, review_reason: null }, { review_reason: null },             // malformed rows never throw or count
  ]
  assert.equal(searchableCompanyCount(rows, companyKey), 2)
  assert.equal(searchableCompanyCount([], companyKey), 0)
})

test('#1037 run report: a search that got no answer is counted as failed, never as "searched, found nobody"', async () => {
  // The provider answers 503 for every search: nothing was learned.
  { const { db, job } = setup([['L-corvane', 'Corvane', 'quote_unconfirmed', 50], ['L-helpwell', 'Helpwell', null, 40]]); const stats = newPeopleStats()
    const f = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: f, stats }), 0)
    assert.equal(stats.searched, 2); assert.deepEqual(stats.failed, { unavailable: 2 }); assert.equal(stats.results, 0)
    assert.equal(peopleStatsDetail(stats).search_failed_unavailable, 2)
    const msg = String(peopleTraceMessage(0, null, stats))
    assert.equal(msg, '2 search(es) attempted, none got an answer (unavailable x2): nothing was learned about who to contact')
    assert.doesNotMatch(msg, /none named a role-matching person/) }
  // Our own per-minute gate refuses the search before anything is sent: counted as rate, and the sentence does not say "sent".
  { const st = { ...newPeopleStats(), eligible: 1, searched: 1, failed: { rate: 1 } }
    assert.equal(peopleTraceMessage(0, null, st), '1 search(es) attempted, none got an answer (rate x1): nothing was learned about who to contact')
    assert.equal(peopleStatsDetail(st).search_failed_rate, 1) }
  // One of two answered, with nobody: the sentence says how many got no answer.
  { const { db, job } = setup([['L-corvane', 'Corvane', 'quote_unconfirmed', 50], ['L-helpwell', 'Helpwell', null, 40]]); const stats = newPeopleStats(); let n = 0
    const f = (async () => ++n === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ results: [] }))) as unknown as typeof fetch
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: f, stats }), 0)
    assert.equal(peopleTraceMessage(0, null, stats), "2 search(es) run (1 got no answer), 0 result(s): none named a role-matching person at the lead's company") }
})
