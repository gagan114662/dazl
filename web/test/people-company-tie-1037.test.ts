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
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { migrateTinyfish, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { findPeople, newPeopleStats, peopleStatsDetail, peopleTraceMessage, peopleTraceStatus, LABEL } from '../lib/people/people-search.ts'
import { companyTie, companyTied, requestedCities, tiedLabel, NAME_ONLY_SOURCE } from '../lib/people/company-tie.ts'
import { opportunityCard } from '../lib/scan/opportunity.ts'
import { bestPeople } from '../lib/people/best-person.ts'
import { sqliteDb } from '../lib/db/client.ts'
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
  assert.deepEqual(stored(db), [{ company: 'Garage', value: 'Casey Flynn, Co-Founder & CEO', label: `${LABEL}; company confirmed beyond its name: the result gives its Y Combinator batch`, source_url: 'https://www.linkedin.com/in/person-c-test' }])
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

test('#1037 the tie: the lead\'s confirmed website, its Y Combinator batch next to its name, or the requested CITY - in the result itself', () => {
  const yc = { company: 'Garage', confirmed_domain: null, source_url: 'https://www.ycombinator.com/companies/garage-2/jobs/x' }
  assert.equal(companyTie('Co-Founder & CEO at Garage (YC W24) · New York', yc), 'source')
  assert.equal(companyTie('Co-Founder & CEO - Garage, YC W24', yc), 'source'); assert.equal(companyTie('Casey Flynn | Garage (YC W24)', yc), 'source'); assert.equal(companyTie('Co-Founder Garage (YC W24)', yc), 'source'); assert.equal(companyTie('Founder with Garage (YC W24)', yc), 'source')
  // Known limit, kept on purpose: after a spaced separator the name starts fresh (the usual "Title - Company (YC W24)" headline), so
  // "... Nautilus Ventures - Garage (YC W24)" ties too. In the search the result line has already passed the profile parser's own employer check.
  assert.equal(companyTie('Partner at Nautilus Ventures - Garage (YC W24)', yc), 'source')
  // A mention of YC is not the company's batch (council probes): a venture firm, an alum, another business with a longer name.
  for (const t of ['Managing Partner - Nautilus Venture Partners · Investor in YC companies', 'Founder & CEO - The Garage · Alumni of Y Combinator Startup School. Orlando', 'Founder at Garage, a Y Combinator company', 'Founder at Garage · Former YC Fellow',
    'Founder & CEO at The Garage (YC S20) · Orlando', 'CEO at Mega Garage (YC W21)', 'Partner at Nautilus & Garage (YC S20)', 'Ventures-Garage (YC W24)', 'Nautilus/Garage (YC W24)', 'Nautilus.Garage (YC W24)', 'Super-Garage (YC W24)', "O'Garage (YC W24)", 'at the Garage (YC S20)', 'nautilus garage (YC W24)', 'Partner at nautilus garage (YC W24)', 'Mr. Garage (YC W24)', 'Founder at Garage · NYC', 'Founder & CEO · The Garage · healthcare software', 'Founder at Garage (YC 2024 fan)']) assert.equal(companyTie(t, yc), null, t)
  // Only the company's own YC page: not Hacker News, not another host, not a YC blog post.
  for (const src of ['https://news.ycombinator.com/item?id=1', 'https://news.example.test/garage-raises', 'https://notycombinator.com/companies/garage', 'https://www.ycombinator.com/blog/garage', 'https://www.ycombinator.com.evil.example/companies/garage', 'not a url', null])
    assert.equal(companyTie('Co-Founder & CEO at Garage (YC W24)', { company: 'Garage', confirmed_domain: null, source_url: src }), null, String(src))
  const site = { company: 'Garage', confirmed_domain: 'withgarage.com', source_url: 'https://news.example.test/a' }
  assert.equal(companyTie('CEO at Garage · withgarage.com · used equipment marketplace', site), 'domain')
  assert.equal(companyTie('CEO at Garage · www.WithGarage.com', site), 'domain')
  for (const t of ['CEO at Garage · notwithgarage.com', 'CEO at Garage · withgarage.community', 'CEO at Garage · withgarage.com.evil.example', 'CEO at Garage']) assert.equal(companyTie(t, site), null, t)
  assert.equal(companyTie('CEO at Garage', { company: 'Garage', confirmed_domain: 'com', source_url: null }), null, 'a bare TLD is not a domain')
  // The place: a CITY the request names, named in the result, and only when the place rule agreed. Never a country, state or province.
  const none = { company: 'Garage', confirmed_domain: null, source_url: null }
  assert.equal(companyTie('Chicago, Illinois, United States · CEO · Garage', none, ['Chicago, Illinois'], true), 'place')
  assert.equal(companyTie('Chicago, Illinois, United States · CEO · Garage', none, ['Chicago'], true), 'place')
  assert.equal(companyTie('Chicago, Illinois, United States · CEO · Garage', none, ['Chicago, Illinois'], false), null, 'the place rule did not agree')
  for (const t of ['Greater Chicago Area · CEO · Garage', 'Chicago Metropolitan Area · CEO · Garage', 'Chicagoland · CEO · Garage']) assert.equal(companyTie(t, none, ['Chicago, Illinois'], true), null, t)
  for (const where of [['United States'], ['Illinois'], ['IL'], ['USA'], ['Illinois, United States'], ['Illinois, USA'], ['Midwest, USA'], ['Ontario'], ['Canada'], ['UK'], ['Europe'], ['New York'], ['Japan'], ['Bavaria'], ['Midwest'], ['Bay Area'], [], [5], ['Dallas, Texas']]) assert.equal(companyTie('Chicago, Illinois, United States · CEO · Garage', none, where, true), null, JSON.stringify(where))
  assert.deepEqual(requestedCities(['Toronto, Ontario', 'Texas', 'United States', 'London', 'New York, NY', 'New York', 'Washington, DC', 'Washington', 'Lyon, France', 'x', 7]), ['Toronto', 'London', 'New York', 'Washington', 'Lyon'])
  // Regions and areas the place rule knows or does not know: none is a city (positive evidence only).
  assert.deepEqual(requestedCities(['Japan', 'Brazil', 'Israel', 'Mexico', 'Puerto Rico', 'Bavaria', 'Midwest', 'West Coast', 'Bay Area', 'Silicon Valley', 'Washington State', 'Europe', 'Remote', 'Sydney', 'Austin', 'Springfield',
    'California, USA', 'Ontario, Canada', 'Texas, United States', 'Georgia, USA', 'Bavaria, Germany', 'Quebec, Canada', 'Mexico, Mexico', 'Bay Area, California', 'Bay Area, CA', 'Silicon Valley, CA', 'Greater Boston Area, MA', 'Midwest, USA', 'Remote, US', 'Austin, Texas', 'Sydney, Australia', 'Victoria, BC', 'Alberta, Canada', 'Victoria, Australia', 'Washington, United States', 'Oregon, USA']), [], 'only a city on the place rule\'s own list, bare or with its region')
  // The city inside the company's own name is not a place (council probe): "Austin Logistics" names no place.
  assert.equal(companyTie('Jo Lee - Head of Sales - Chicago Logistics | LinkedIn', { company: 'Chicago Logistics', confirmed_domain: null, source_url: null }, ['Chicago, Illinois'], true), null)
  assert.equal(companyTie('Jo Lee - Head of Sales - Chicago Logistics | LinkedIn · Chicago, Illinois', { company: 'Chicago Logistics', confirmed_domain: null, source_url: null }, ['Chicago, Illinois'], true), 'place')
  assert.equal(companyTie('Jo - Owner - Toronto Dental Studio · Toronto, Ontario', { company: 'Toronto Dental Studio', confirmed_domain: null, source_url: null }, ['Toronto, Ontario'], true), 'place')
  assert.equal(companyTie('Jo - CEO - Garage · Texas, United States', none, ['Texas, United States'], true), null, 'a state written with its country is still a state')
  assert.equal(companyTie('Greater Austintown area · CEO · Garage', none, ['Austin, Texas'], true), null, 'the city as a whole word')
  assert.equal(companyTie(undefined as unknown as string, { company: 7 as unknown as string, confirmed_domain: 5 as unknown as string, source_url: 7 as unknown as string }, 'x' as unknown as string[], true), null)
})

test('#1037 through the search: the website tie needs the lead\'s CONFIRMED domain; a city ties, a state or country does not', async () => {
  const g = [...RESULTS.Syncly, { url: 'https://www.linkedin.com/in/person-g-test', title: 'Gray Lindqvist - Co-Founder - Syncly | LinkedIn', snippet: 'Co-Founder at Syncly · syncly.app · customer feedback analysis' }]
  // company_domain set but never confirmed (a name guess): the result naming it is NOT tied.
  { const { db, job } = setup(ICP, { Syncly: 'syncly.app' }); const stats = newPeopleStats()
    await findPeople(db, 'A', job, { env, fetchImpl: stub({ ...RESULTS, Syncly: g }), stats })
    assert.deepEqual(stored(db).filter(r => r.company === 'Syncly'), []); assert.equal(stats.refused.company_unconfirmed, 6) }
  // The same domain, confirmed by the crawl (the lead's own evidence page is on it): tied, and only that result.
  { const { db, job } = setup(ICP, { Syncly: 'syncly.app' })
    addEnrichment(db, 'A', 'L-syncly', { connector: 'sitecrawl', kind: 'domain', value: 'syncly.app|evidence_own_domain', label: 'domain-basis-v1:evidence_own_domain', confidence: null, source_url: 'https://syncly.app/', source_date: '2026-11-13', retrieved_at: 1 })
    await findPeople(db, 'A', job, { env, fetchImpl: stub({ ...RESULTS, Syncly: g }) })
    assert.deepEqual(stored(db).filter(r => r.company === 'Syncly').map(r => [r.value, r.label.split(': ').pop()]), [['Gray Lindqvist, Co-Founder', 'the result names its website']]) }
  // A request that names a city the place rule knows keeps the result naming that city.
  { const p = setup({ ...ICP, where: ['Melbourne, Australia'] })
    const melb = { ...RESULTS, Syncly: [{ url: 'https://au.linkedin.com/in/person-h-test', title: 'Harper Quill - Founder - Syncly | LinkedIn', snippet: 'Melbourne, Victoria, Australia · Founder · Syncly' }, ...RESULTS.Syncly] }
    await findPeople(p.db, 'A', p.job, { env, fetchImpl: stub(melb) })
    assert.deepEqual(stored(p.db).filter(r => r.company === 'Syncly').map(r => [r.value, r.label.split(': ').pop()]), [['Harper Quill, Founder', 'the result names the requested city']]) }
  // A city the place rule does not list never ties (fail closed): the Sydney founder on a "Sydney, Australia" request.
  { const p = setup({ ...ICP, where: ['Sydney, Australia'] }); await findPeople(p.db, 'A', p.job, { env, fetchImpl: stub() }); assert.deepEqual(stored(p.db).filter(r => r.company === 'Syncly'), []) }
  // A request that names only a country or a state: the place rule agrees, but that is not a tie (a same-name business in the same country).
  for (const where of [['Australia'], ['New South Wales'], ['United States'], ['California']]) {
    const p = setup({ ...ICP, where }); const stats = newPeopleStats(); await findPeople(p.db, 'A', p.job, { env, fetchImpl: stub(), stats })
    assert.deepEqual(stored(p.db).filter(r => !r.label.endsWith('Y Combinator batch')), [], JSON.stringify(where))
    // "Long Beach, California" agrees with a California request, and is still refused: a state is not a tie.
    if (where[0] === 'California') assert.ok((stats.refused.company_unconfirmed ?? 0) >= 1, JSON.stringify(stats.refused))
  }
})

test('#1037 a person already stored by the name alone gets the tie when a later search finds them with one (no duplicate, counted once, not searched again)', async () => {
  const { db, job } = setup()
  // As staging holds the Garage co-founder today: the bare label.
  // ... and from ANOTHER profile of the same name (the name-only result may have been a different person's).
  addEnrichment(db, 'A', 'L-garage', { connector: 'search:people', kind: 'person', value: 'Casey Flynn, Co-Founder & CEO', label: LABEL, confidence: null, source_url: 'https://www.linkedin.com/in/another-casey-test', source_date: '2026-11-10', retrieved_at: 1 })
  assert.equal(leadPerson(rowsOf(db, 'L-garage'), WHO.join('; ')), null, 'name-only before')
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub() }), 1)
  assert.deepEqual(stored(db).filter(r => r.company === 'Garage').map(r => [r.value, r.label.split(': ').pop(), r.source_url]), [['Casey Flynn, Co-Founder & CEO', 'the result gives its Y Combinator batch', 'https://www.linkedin.com/in/person-c-test']], 'one row, now tied, linking to the TIED result\'s profile')
  assert.equal(leadPerson(rowsOf(db, 'L-garage'), WHO.join('; '))?.name, 'Casey Flynn')
  // A second pass finds the same tied person: nothing new is stored or counted.
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub() }), 0)
  // First play: the lead now names its person, so no search is spent on it again.
  const asked: string[] = []
  const f = (async (u: string) => { asked.push(/"([^"]+)"/.exec(new URL(u).searchParams.get('query') ?? '')?.[1] ?? ''); return new Response('{"results":[]}') }) as unknown as typeof fetch
  await findPeople(db, 'A', job, { env, fetchImpl: f, maxCompanies: 10, skipNamed: true })
  assert.deepEqual(asked.sort(), ['Nautilus', 'Syncly'])
})

test('#1037 a name-only row is never the opportunity card\'s "who" or the CSV\'s best person; a tied row beside it is', async () => {
  const lead = { id: 'L-garage', company: 'Garage', name: '', contact: null, signal: 'Hiring a founding sales rep', source_url: LEADS[1][2], evidence_excerpt: 'Founding sales role at Garage | Y Combinator', event_date: null, date_status: null, published_at: null, confidence: 90, review_reason: null, company_domain: null, fit: 4, intent: 4, action: 3, why: 'Hiring its first sales rep.', score: 80 }
  const bare = { connector: 'search:people', kind: 'person', value: 'Devon Marsh, Founder & CEO', label: LABEL, source_url: 'https://www.linkedin.com/in/person-d-test', source_date: '2026-11-10', confidence: null, retrieved_at: 1 }
  const tied = { ...bare, value: 'Casey Flynn, Co-Founder & CEO', label: tiedLabel(LABEL, 'source'), source_url: 'https://www.linkedin.com/in/person-c-test' }
  const card = (rows: unknown[]) => opportunityCard({ ...lead, icp_match: null, enrichments: rows } as never, WHO.join('; '))
  assert.equal(card([bare]).who, null, 'the wrong-business founder is not "who"')
  assert.equal(card([bare, tied]).who?.name, 'Casey Flynn')
  // CSV best person (lib/people/best-person.ts), through the database.
  const { db } = setup()
  const adb = sqliteDb(db)
  const job = (db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  addEnrichment(db, 'A', 'L-garage', bare as never)
  assert.equal((await bestPeople(adb, 'A', [{ lead_id: 'L-garage', job_id: job }])).get('L-garage')?.best_person, '', 'a name-only row alone: no best person')
  addEnrichment(db, 'A', 'L-garage', tied as never)
  assert.equal((await bestPeople(adb, 'A', [{ lead_id: 'L-garage', job_id: job }])).get('L-garage')?.best_person, 'Casey Flynn')
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
  assert.equal(stats.searched, 0, 'a search the cap refused is not a search that ran')
  // Only a real limit is a planned stop. A ledger that could not be read, an unknown price or any other error is an error; a lost job says so.
  for (const [thrown, want] of [[new SpendRefused('owner_pool_limit'), 'spend_cap'], [new SpendRefused('ledger_unavailable'), 'error'], [new SpendRefused('accounting_uncertain'), 'error'], [new SpendRefused('price_unknown'), 'error'], [new SpendRefused('ownership_lost'), 'ownership_lost'], [new SpendRefused('scan_not_active'), 'ownership_lost'], [new SpendRefused('trial_budget_reached'), 'budget_kept'], [new Error('boom'), 'error']] as [Error, string][]) {
    const w: string[] = []
    await findPeople(db, 'A', job, { env, fetchImpl: f, onStop: x => w.push(x), charge: async () => { throw thrown } })
    assert.deepEqual(w, [want], thrown.message)
  }
  assert.equal(sent, 0)
})

