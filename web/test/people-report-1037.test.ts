// #1037: the run report's people_search stage says what the pass did (eligible, searched, results, refusals by cause), and a pass
// that sent no search never reads as "no profile results". Real staging rows (job 13808d9c, helpers/people-real-13808d9c.ts);
// TinyFish stubbed: no network, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findPeople, newPeopleStats, peopleSearchable, peopleStatsDetail, peopleTraceMessage, profileHit, SEARCHABLE_HOLDS } from '../lib/people/people-search.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { REAL_ICP as ICP, REAL_RESULTS as RESULTS, env, setup, stub } from './helpers/people-real-13808d9c.ts'

test('#1037 run report: which holds the pass may search is one fail-closed list', () => {
  for (const r of ['counterparty_signal', 'location_mismatch', 'location_unconfirmed', 'self_description', 'first_party_signal', 'some_future_reason', '']) assert.equal(peopleSearchable(r), false, r)
  for (const r of [null, undefined, 'quote_unconfirmed', 'blocked_by_site', 'outside_window_undated', 'needs_javascript', 'no_sales_hiring_evidence']) assert.equal(peopleSearchable(r), true, String(r))
  for (const r of SEARCHABLE_HOLDS) assert.match(r, /^[a-z_]+$/, 'reasons are inlined into SQL: plain identifiers only')
})


test('#1037 run report: the pass counts what it did, with refusals by cause', async () => {
  const { db, job } = setup([['L-pagerduty', 'PagerDuty', 'quote_unconfirmed', 90], ['L-kong', 'Kong', null, 50]])
  const s = stub({
    PagerDuty: [
      ...RESULTS.PagerDuty,
      { url: 'https://www.linkedin.com/company/pagerduty', title: 'PagerDuty | LinkedIn' },                                                       // not a profile
      { url: 'https://www.linkedin.com/in/top-reps', title: 'Top 10 sales leaders to follow | LinkedIn' },                                       // unreadable
      { url: 'https://www.linkedin.com/in/old-hand', title: 'Olga Hand - Former Sales Manager - PagerDuty | LinkedIn' },                          // past role
      { url: 'https://www.linkedin.com/in/rival-rep', title: 'Rita Rival - Sales Manager - Opsgenie | LinkedIn' },                                // other employer
      { url: 'https://www.linkedin.com/in/sre-sam', title: 'Sam Reyes - Site Reliability Engineer - PagerDuty | LinkedIn' },                      // not a buyer role
    ],
    Kong: [],
  })
  const stats = newPeopleStats()
  const n = await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats })
  assert.equal(n, 2)
  assert.deepEqual(stats, { eligible: 2, held: 1, already_named: 0, searched: 2, results: 7, profiles: 3, refused: { not_profile: 1, unreadable: 1, past_role: 1, other_employer: 1, role: 1 } })
  assert.deepEqual(peopleStatsDetail(stats), { eligible: 2, held_eligible: 1, searched: 2, results: 7, profile_results: 3, refused_not_profile: 1, refused_unreadable: 1, refused_past_role: 1, refused_other_employer: 1, refused_role: 1 })
  assert.equal(profileHit({ url: 'https://www.linkedin.com/in/rival-rep', title: 'Rita Rival - Sales Manager - Opsgenie | LinkedIn', snippet: '', date: null }, 'PagerDuty'), 'other_employer')
  assert.deepEqual(profileHit({ url: 'https://www.linkedin.com/in/marksarman', title: RESULTS.PagerDuty[0].title, snippet: '', date: null }, 'PagerDuty'), { name: 'Mark Sarman', title: 'Regional Sales Director' })
})

test('#1037 run report: a place refusal is counted (a profile result naming no place, when the request names one)', async () => {
  const { db, job } = setup([['L-kong', 'Kong', 'blocked_by_site', 50]], { ...ICP, where: ['Ohio'] })
  const stats = newPeopleStats()
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub().f, stats }), 0)
  assert.deepEqual(stats.refused, { place: 1 }); assert.equal(peopleStatsDetail(stats).refused_place, 1)
})

test('#1037 run report: a pass that sent no search never reads as "no profile results"', async () => {
  // The 8 matrix scans: nothing eligible. Before, the report said "no profile results named a role-matching person at a verified company".
  { const { db, job } = setup([['L1', 'Kong', 'counterparty_signal', 90]]); const s = stub(); const stats = newPeopleStats()
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats }), 0)
    assert.equal(peopleTraceMessage(0, null, stats), 'no lead was eligible for a people search (0 searches run)') }
  // First play: every eligible lead already names its person.
  { const { db, job } = setup([['L-kong', 'Kong', 'blocked_by_site', 50]]); const stats = newPeopleStats()
    addEnrichment(db, 'A', 'L-kong', { connector: 'search:people', kind: 'person', value: 'Andy Smit, VP of Sales Development & PG', label: 'x', confidence: null, source_url: 'https://www.linkedin.com/in/andysmit', source_date: '2026-11-13', retrieved_at: 1 })
    const s = stub(); assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: s.f, stats, maxCompanies: 10, skipNamed: true }), 0)
    assert.deepEqual(s.companies, []); assert.equal(stats.already_named, 1)
    assert.equal(peopleTraceMessage(0, null, stats), 'every eligible lead already names its person (0 searches run)') }
  // Searched and found nobody: the counts are in the sentence.
  { const { db, job } = setup([['L-cisco', 'Cisco', 'quote_unconfirmed', 50]]); const stats = newPeopleStats()
    assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub().f, stats }), 0)
    assert.equal(peopleTraceMessage(0, null, stats), "1 search(es) run, 0 result(s): none named a role-matching person at the lead's company") }
  // A stop still wins, and a pass that stored someone still has no message.
  const st = { ...newPeopleStats(), eligible: 3, searched: 1, results: 4 }
  assert.match(String(peopleTraceMessage(0, 'quota', st)), /quota is used up/); assert.equal(peopleTraceMessage(2, null, st), null)
  // Malformed counts never throw and never print NaN.
  const bad = { eligible: NaN, held: -1, already_named: 1.5, searched: Infinity, results: '7', profiles: null, refused: { role: -3, place: NaN, __proto__: 5 } } as unknown as ReturnType<typeof newPeopleStats>
  assert.deepEqual(peopleStatsDetail(bad), { eligible: 0, held_eligible: 0, searched: 0, results: 0, profile_results: 0 })
})
