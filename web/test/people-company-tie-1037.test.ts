// #1037 (Hermes-PC review of PR #1164, finding 1): a company NAME is not a company. On staging, 5 of the 9 people the profile
// search had stored were at a DIFFERENT business with the same name. Built from those real rows (docs/NEVER-AGAIN.md rule 5):
//   - the three leads as staging holds them: Nautilus, Garage and Syncly, each found on its Y Combinator company page
//     (source_url as stored), no confirmed domain, a request with no place (roles Founder / CEO / Co-Founder);
//   - the six stored results by employer and title as the review verified them by opening the sources:
//       Nautilus: "Co-Founder & Managing Director" of Nautilus Venture Partners (a VC firm) and "President and CEO" of Nautilus
//                 International Holding Corporation (port operations, Long Beach): both another business;
//       Garage:   "Founder & CEO" of The Garage (healthcare software, Orlando): another business; "Co-Founder & CEO" of Garage (YC W24): right;
//       Syncly:   "Founder and CEO" of Syncly (legal-tech integration, Sydney) and "Founder" of Syncly (a mobile app studio, Ahmedabad): both another business.
// Anonymised where needed: the PEOPLE's names and profile URLs are invented (they are private individuals; the companies, titles and
// employer wording are the real ones). The raw search answers were never stored, so each result line is rebuilt in the shape the
// parser accepted ("Name - Title - Employer | LinkedIn") with what its source says about the employer. TinyFish stubbed: no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateTinyfish, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { findPeople, newPeopleStats, peopleStatsDetail, peopleTraceMessage, peopleTraceStatus, LABEL } from '../lib/people/people-search.ts'
import { companyTie, companyTied, tiedLabel, NAME_ONLY_SOURCE } from '../lib/people/company-tie.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import { contactsFromEnrichments, peopleSourceText } from '../lib/people/rank.ts'
import { isWorkEmailTarget } from '../lib/people/work-email-eligible.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'

const WHO = ['Founder', 'CEO', 'Co-Founder']
const ICP = { summary: 'Founders or CEOs at B2B SaaS startups hiring their first sales rep', who: WHO, industries: ['B2B SaaS'], sizes: [], where: [], signals: ['Hiring first sales rep'], exclude: [] }
const env = { TINYFISH_API_KEY: 'k', TINYFISH_TENANT_DAILY: '50' }
const LEADS: [id: string, company: string, source_url: string][] = [
  ['L-nautilus', 'Nautilus', 'https://www.ycombinator.com/companies/nautilus/jobs/ePUjzKu-senior-bdr'],
  ['L-garage', 'Garage', 'https://www.ycombinator.com/companies/garage-2/jobs/oESnEDf-founding-sales-development-representative-sdr'],
  ['L-syncly', 'Syncly', 'https://www.ycombinator.com/companies/syncly/jobs/d5DclHl-founding-account-executive-ae'],
]
const RESULTS: Record<string, { url: string; title: string; snippet: string }[]> = {
  Nautilus: [
    { url: 'https://www.linkedin.com/in/person-a-test', title: 'Avery Stone - Co-Founder & Managing Director - Nautilus | LinkedIn', snippet: 'Co-Founder & Managing Director at Nautilus Venture Partners · venture capital · San Francisco Bay Area' },
    { url: 'https://www.linkedin.com/in/person-b-test', title: 'Blake Rivers - President and CEO at Nautilus | LinkedIn', snippet: 'Long Beach, California · President and CEO · Nautilus International Holding Corporation · port and terminal operations' },
  ],
  Garage: [
    { url: 'https://www.linkedin.com/in/person-c-test', title: 'Casey Flynn - Co-Founder & CEO - Garage | LinkedIn', snippet: 'Co-Founder & CEO at Garage (YC W24) · New York' },
    { url: 'https://www.linkedin.com/in/person-d-test', title: 'Devon Marsh - Founder & CEO - The Garage | LinkedIn', snippet: 'Orlando, Florida · Founder & CEO · The Garage · healthcare software' },
  ],
  Syncly: [
    { url: 'https://au.linkedin.com/in/person-e-test', title: 'Emery Vale - Founder and CEO - Syncly | LinkedIn', snippet: 'Sydney, New South Wales, Australia · Founder and CEO · Syncly · integrations for law firms' },
    { url: 'https://in.linkedin.com/in/person-f-test', title: 'Farah Dalal - Founder - Syncly | LinkedIn', snippet: 'Ahmedabad, Gujarat, India · Founder · Syncly · mobile app studio' },
  ],
}
function setup(icp: unknown = ICP, domains: Record<string, string> = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateTinyfish(db); resetTinyfishState()
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(icp), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,company_domain) VALUES (?,?,?,?,?,?,?,?,?,?)')
  LEADS.forEach(([id, company, src], i) => ins.run(id, job, company, null, 'Hiring a founding sales rep', src, `Founding sales role at ${company} | Y Combinator`, 90, 90 - i, domains[company] ?? null))
  return { db, job }
}
const stub = (results = RESULTS) => (async (u: string) => new Response(JSON.stringify({ results: results[/"([^"]+)"/.exec(new URL(u).searchParams.get('query') ?? '')?.[1] ?? ''] ?? [] }))) as unknown as typeof fetch
const stored = (db: Database.Database) => db.prepare("SELECT l.company, e.value, e.label, e.source_url FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id WHERE e.connector = 'search:people' AND e.kind = 'person' ORDER BY e.insert_seq").all() as { company: string; value: string; label: string; source_url: string }[]
const rowsOf = (db: Database.Database, id: string) => db.prepare("SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind IN ('person','contact') ORDER BY insert_seq").all(id)

test('#1037 real rows (Nautilus, Garage, Syncly): the five people at a same-name business are refused and counted; the Garage (YC W24) co-founder is kept', async () => {
  const { db, job } = setup(); const stats = newPeopleStats()
  const n = await findPeople(db, 'A', job, { env, fetchImpl: stub(), stats })
  assert.equal(n, 1)
  assert.deepEqual(stored(db), [{ company: 'Garage', value: 'Casey Flynn, Co-Founder & CEO', label: `${LABEL}; company confirmed beyond its name: the result names the organisation the lead was found through`, source_url: 'https://www.linkedin.com/in/person-c-test' }])
  assert.equal(stats.refused.company_unconfirmed, 5); assert.equal(peopleStatsDetail(stats).refused_company_unconfirmed, 5)
  assert.equal(stats.searched, 3); assert.equal(stats.profiles, 6, 'all six were read as a person at an employer of that NAME')
  // The rows: Garage names its person; Nautilus and Syncly name nobody (no wrong person on the row).
  assert.equal(leadPerson(rowsOf(db, 'L-garage'), WHO.join('; '))?.name, 'Casey Flynn')
  assert.equal(leadPerson(rowsOf(db, 'L-nautilus'), WHO.join('; ')), null); assert.equal(leadPerson(rowsOf(db, 'L-syncly'), WHO.join('; ')), null)
})

test('#1037 real rows: the rows staging already holds (stored by the name alone) are no longer the lead\'s person, export or email target, and say so in plain words', () => {
  // As stored on staging before this rule: the bare label, six people, five of them at another business.
  const legacy = (value: string, url: string) => ({ kind: 'person', value, label: LABEL, source_url: url, connector: 'search:people' })
  const nautilus = [legacy('Avery Stone, Co-Founder & Managing Director', 'https://www.linkedin.com/in/person-a-test'), legacy('Blake Rivers, President and CEO', 'https://www.linkedin.com/in/person-b-test')]
  const syncly = [legacy('Emery Vale, Founder and CEO', 'https://au.linkedin.com/in/person-e-test'), legacy('Farah Dalal, Founder', 'https://in.linkedin.com/in/person-f-test')]
  for (const rows of [nautilus, syncly]) {
    assert.equal(leadPerson(rows, WHO.join('; ')), null, 'no row line: the Leads page reads "No buyer named yet"')
    const listed = contactsFromEnrichments(rows, WHO.join('; '))
    assert.equal(listed.length, 2, 'still listed in the details, never hidden')
    for (const p of listed) { assert.equal(p.nameOnly, true); assert.equal(peopleSourceText(p), NAME_ONLY_SOURCE); assert.equal(isWorkEmailTarget(p, WHO.join('; ')), false) }
  }
  assert.equal(NAME_ONLY_SOURCE, 'a public LinkedIn search result matched by the company name only - this may be a different business with the same name')
  // The same person stored WITH a tie is the lead's person again.
  const tied = [{ kind: 'person', value: 'Casey Flynn, Co-Founder & CEO', label: tiedLabel(LABEL, 'source'), source_url: 'https://www.linkedin.com/in/person-c-test', connector: 'search:people' }]
  assert.equal(leadPerson(tied, WHO.join('; '))?.name, 'Casey Flynn'); assert.equal(contactsFromEnrichments(tied, WHO.join('; '))[0].nameOnly, undefined)
  // A label that merely looks similar is not a tie (only tiedLabel's exact endings count); other connectors are untouched.
  for (const l of [LABEL, `${LABEL}; company confirmed beyond its name: trust me`, 'company confirmed beyond its name: the result names its website x', '', null, 5]) assert.equal(companyTied(l), false, String(l))
  assert.equal(contactsFromEnrichments([{ kind: 'person', value: 'Dana Lee, CEO', label: 'x', source_url: 'https://acme.example/team', connector: 'sitecrawl' }], 'CEO')[0].nameOnly, undefined)
})

test('#1037 the tie: the lead\'s website, the organisation it was found through, or the requested place - named in the result itself', async () => {
  const yc = { company_domain: null, source_url: 'https://www.ycombinator.com/companies/garage-2/jobs/x' }
  assert.equal(companyTie('Co-Founder & CEO at Garage (YC W24) · New York', yc, false), 'source')
  assert.equal(companyTie('Founder at Garage, a Y Combinator company', yc, false), 'source')
  assert.equal(companyTie('Founder & CEO · The Garage · healthcare software', yc, false), null)
  assert.equal(companyTie('Founder at Garage · NYC', yc, false), null, '"NYC" is not "YC"')
  assert.equal(companyTie('Co-Founder & CEO at Garage (YC W24)', { company_domain: null, source_url: 'https://news.example.test/garage-raises' }, false), null, 'YC named, but the lead was not found on a Y Combinator page')
  assert.equal(companyTie('Co-Founder & CEO at Garage (YC W24)', { company_domain: null, source_url: 'https://notycombinator.com/x' }, false), null)
  const site = { company_domain: 'withgarage.com', source_url: 'https://news.example.test/a' }
  assert.equal(companyTie('CEO at Garage · withgarage.com · used equipment marketplace', site, false), 'domain')
  assert.equal(companyTie('CEO at Garage · www.WithGarage.com', site, false), 'domain')
  for (const t of ['CEO at Garage · notwithgarage.com', 'CEO at Garage · withgarage.community', 'CEO at Garage · withgarage.com.evil.example', 'CEO at Garage']) assert.equal(companyTie(t, site, false), null, t)
  assert.equal(companyTie('CEO at Garage', { company_domain: 'com', source_url: null }, false), null, 'a bare TLD is not a domain')
  assert.equal(companyTie('CEO at Garage', { company_domain: null, source_url: null }, true), 'place')
  assert.equal(companyTie(undefined as unknown as string, { company_domain: 5 as unknown as string, source_url: 7 as unknown as string }, false), null)
  // Through the search: the website tie stores the Syncly founder whose result names syncly.app, and no other.
  const { db, job } = setup(ICP, { Syncly: 'syncly.app' })
  const results = { ...RESULTS, Syncly: [...RESULTS.Syncly, { url: 'https://www.linkedin.com/in/person-g-test', title: 'Gray Lindqvist - Co-Founder - Syncly | LinkedIn', snippet: 'Co-Founder at Syncly · syncly.app · customer feedback analysis' }] }
  await findPeople(db, 'A', job, { env, fetchImpl: stub(results) })
  assert.deepEqual(stored(db).filter(r => r.company === 'Syncly').map(r => [r.value, r.label.split(': ').pop()]), [['Gray Lindqvist, Co-Founder', 'the result names its website']])
  // Through the search: a request that names a place keeps the result naming that place (the existing rule, now the tie).
  const p = setup({ ...ICP, where: ['Sydney'] })
  await findPeople(p.db, 'A', p.job, { env, fetchImpl: stub() })
  assert.deepEqual(stored(p.db).map(r => [r.company, r.value, r.label.split(': ').pop()]), [['Syncly', 'Emery Vale, Founder and CEO', 'the result names the requested place']])
})

test('#1037 review finding 3: a search refused by the scan\'s spend cap is counted as not sent, with its cause, and the message names the spend cap', async () => {
  const { db, job } = setup(); const stats = newPeopleStats(); const why: string[] = []; let sent = 0
  const f = (async () => { sent++; return new Response('{"results":[]}') }) as unknown as typeof fetch
  // The scan's own cap refuses the search before anything is sent (lib/search/tinyfish.ts throws SpendRefused): here through the charge hook.
  const n = await findPeople(db, 'A', job, { env, fetchImpl: f, stats, onStop: w => why.push(w), charge: async () => { throw new SpendRefused('over_cap') } })
  assert.equal(n, 0); assert.equal(sent, 0, 'nothing was sent'); assert.deepEqual(why, ['spend_cap'], 'a planned stop, not "error"')
  assert.deepEqual(stats.failed, { spend_cap: 1 }); assert.equal(peopleStatsDetail(stats).search_failed_spend_cap, 1)
  assert.equal(peopleTraceStatus(n, 'spend_cap'), 'attempted_no_result', 'not "failed": the pass stopped at its own limit')
  assert.equal(peopleTraceMessage(n, 'spend_cap', stats), "the people search stopped at this scan's spend cap (the next search did not fit, so it was not sent); 0 person(s) stored before it stopped")
  // Any other error is still an error.
  const why2: string[] = []
  await findPeople(db, 'A', job, { env, fetchImpl: f, onStop: w => why2.push(w), charge: async () => { throw new Error('boom') } })
  assert.deepEqual(why2, ['error'])
})

