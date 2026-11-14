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
import { companyTie, companyTied, tiedLabel, NAME_ONLY_SOURCE, NAME_ONLY_REASON } from '../lib/people/company-tie.ts'
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

test('#1037 real rows (Nautilus, Garage, Syncly): with no confirmed website all six results are refused and counted; nothing is stored and every row names nobody', async () => {
  const { db, job } = setup(); const stats = newPeopleStats()
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub(), stats }), 0)
  assert.deepEqual(stored(db), []); assert.equal(stats.refused.company_unconfirmed, 6); assert.equal(peopleStatsDetail(stats).refused_company_unconfirmed, 6)
  assert.equal(stats.searched, 3); assert.equal(stats.profiles, 6, 'all six were read as a person at an employer of that NAME')
  for (const id of ['L-nautilus', 'L-garage', 'L-syncly']) assert.equal(leadPerson(rowsOf(db, id), WHO.join('; ')), null, id)
  // The decision (Hermes, #1164): the correct Garage (YC W24) co-founder is refused too. A wrong name is worse than none; the grounded lookup of #1102 is the path to naming more.
})

test('#1037 a result is kept only when it names the lead\'s CONFIRMED website', async () => {
  // Garage's website is confirmed (its evidence page is on it) and the result names it: that result, and only that one, is stored.
  const { db, job } = setup(ICP, { Garage: 'withgarage.com' })
  addEnrichment(db, 'A', 'L-garage', { connector: 'sitecrawl', kind: 'domain', value: 'withgarage.com|evidence_own_domain', label: 'domain-basis-v1:evidence_own_domain', confidence: null, source_url: 'https://withgarage.com/', source_date: '2026-11-13', retrieved_at: 1 })
  const results = { ...RESULTS, Garage: [{ ...RESULTS.Garage[0], snippet: 'Co-Founder & CEO at Garage · withgarage.com · New York' }, RESULTS.Garage[1]] }
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub(results) }), 1)
  assert.deepEqual(stored(db).map(r => [r.company, r.value, r.label.split(': ').pop()]), [['Garage', 'Casey Flynn, Co-Founder & CEO', 'the result names its website']])
  assert.equal(leadPerson(rowsOf(db, 'L-garage'), WHO.join('; '))?.name, 'Casey Flynn')
  // A domain that is set but NEVER confirmed (a name guess) ties nothing, even when the result names it.
  { const g = setup(ICP, { Garage: 'withgarage.com' }); const stats = newPeopleStats()
    await findPeople(g.db, 'A', g.job, { env, fetchImpl: stub(results), stats }); assert.deepEqual(stored(g.db), []); assert.equal(stats.refused.company_unconfirmed, 6) }
})

test('#1037 the tie: the confirmed website as a whole token, nothing else', () => {
  const site = { company: 'Garage', confirmed_domain: 'withgarage.com' }
  assert.equal(companyTie('CEO at Garage · withgarage.com · used equipment marketplace', site), 'domain')
  assert.equal(companyTie('CEO at Garage · www.WithGarage.com', site), 'domain')
  for (const t of ['CEO at Garage · notwithgarage.com', 'CEO at Garage · withgarage.community', 'CEO at Garage · withgarage.com.evil.example', 'CEO at Garage'])
    assert.equal(companyTie(t, site), null, t)
  assert.equal(companyTie('CEO at Garage', { company: 'Garage', confirmed_domain: 'com' }), null, 'a bare TLD is not a domain')
  // The earlier free-text ties are gone (Hermes decision on #1164): none of these ties without the website.
  for (const t of ['Co-Founder & CEO at Garage (YC W24) · New York', 'Founder at Garage · Chicago, Illinois, United States', 'Jo - Owner - Toronto Dental Studio · Toronto, Ontario', 'Founder at Garage, a Y Combinator company'])
    assert.equal(companyTie(t, { company: 'Garage', confirmed_domain: null }), null, t)
  assert.equal(companyTie(undefined as unknown as string, { company: 7 as unknown as string, confirmed_domain: 5 as unknown as string }), null)
})

test('#1037 rows already stored by the name alone are no longer the lead\'s person, card "who", best person or email target, and say so', async () => {
  const legacy = (value: string, url: string) => ({ kind: 'person', value, label: LABEL, source_url: url, connector: 'search:people' })
  const nautilus = [legacy('Avery Stone, Co-Founder & Managing Director', 'https://www.linkedin.com/in/person-a-test'), legacy('Blake Rivers, President and CEO', 'https://www.linkedin.com/in/person-b-test')]
  assert.equal(leadPerson(nautilus, WHO.join('; ')), null)
  const listed = contactsFromEnrichments(nautilus, WHO.join('; '))
  assert.equal(listed.length, 2, 'still listed in the details, never hidden')
  for (const p of listed) { assert.equal(p.nameOnly, true); assert.equal(peopleSourceText(p), NAME_ONLY_SOURCE); assert.equal(isWorkEmailTarget(p, WHO.join('; ')), false) }
  assert.match(NAME_ONLY_REASON, /^No buyer named: .*nothing confirms it is this company/)
  const tied = [{ kind: 'person', value: 'Casey Flynn, Co-Founder & CEO', label: tiedLabel(LABEL, 'domain'), source_url: 'https://www.linkedin.com/in/person-c-test', connector: 'search:people' }]
  assert.equal(leadPerson(tied, WHO.join('; '))?.name, 'Casey Flynn'); assert.equal(contactsFromEnrichments(tied, WHO.join('; '))[0].nameOnly, undefined)
  for (const l of [LABEL, `${LABEL}; company confirmed beyond its name: trust me`, 'company confirmed beyond its name: the result names its website x', '', null, 5]) assert.equal(companyTied(l), false, String(l))
  // The old labels of the dropped ties no longer count as tied.
  for (const old of ['the result gives its Y Combinator batch', 'the result names the requested city', 'the result names the organisation the lead was found through']) assert.equal(companyTied(`${LABEL}; company confirmed beyond its name: ${old}`), false, old)
  // Opportunity card and CSV best person.
  const lead = { id: 'L-garage', company: 'Garage', name: '', contact: null, signal: 'Hiring a founding sales rep', source_url: LEADS[1][2], evidence_excerpt: 'Founding sales role at Garage | Y Combinator', event_date: null, date_status: null, published_at: null, confidence: 90, review_reason: null, company_domain: null, fit: 4, intent: 4, action: 3, why: 'Hiring its first sales rep.', score: 80 }
  const bare = { connector: 'search:people', kind: 'person', value: 'Devon Marsh, Founder & CEO', label: LABEL, source_url: 'https://www.linkedin.com/in/person-d-test', source_date: '2026-11-10', confidence: null, retrieved_at: 1 }
  const tiedRow = { ...bare, value: 'Casey Flynn, Co-Founder & CEO', label: tiedLabel(LABEL, 'domain'), source_url: 'https://www.linkedin.com/in/person-c-test' }
  const card = (rows: unknown[]) => opportunityCard({ ...lead, icp_match: null, enrichments: rows } as never, WHO.join('; '))
  assert.equal(card([bare]).who, null); assert.equal(card([bare, tiedRow]).who?.name, 'Casey Flynn')
  const { db } = setup(); const adb = sqliteDb(db); const job = (db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  addEnrichment(db, 'A', 'L-garage', bare as never)
  assert.equal((await bestPeople(adb, 'A', [{ lead_id: 'L-garage', job_id: job }])).get('L-garage')?.best_person, '')
  addEnrichment(db, 'A', 'L-garage', tiedRow as never)
  assert.equal((await bestPeople(adb, 'A', [{ lead_id: 'L-garage', job_id: job }])).get('L-garage')?.best_person, 'Casey Flynn')
})

test('#1037 a person stored by the name alone gets the tie when a later search finds them naming the confirmed website (profile, date and time replaced; counted once)', async () => {
  const { db, job } = setup(ICP, { Garage: 'withgarage.com' })
  addEnrichment(db, 'A', 'L-garage', { connector: 'sitecrawl', kind: 'domain', value: 'withgarage.com|evidence_own_domain', label: 'domain-basis-v1:evidence_own_domain', confidence: null, source_url: 'https://withgarage.com/', source_date: '2026-11-13', retrieved_at: 1 })
  addEnrichment(db, 'A', 'L-garage', { connector: 'search:people', kind: 'person', value: 'Casey Flynn, Co-Founder & CEO', label: LABEL, confidence: null, source_url: 'https://www.linkedin.com/in/another-casey-test', source_date: '2026-11-10', retrieved_at: 1 })
  assert.equal(leadPerson(rowsOf(db, 'L-garage'), WHO.join('; ')), null, 'name-only before')
  const results = { ...RESULTS, Garage: [{ ...RESULTS.Garage[0], snippet: 'Co-Founder & CEO at Garage · withgarage.com' }] }
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub(results) }), 1)
  assert.deepEqual(stored(db).filter(r => r.company === 'Garage').map(r => [r.value, r.label.split(': ').pop(), r.source_url]), [['Casey Flynn, Co-Founder & CEO', 'the result names its website', 'https://www.linkedin.com/in/person-c-test']])
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: stub(results) }), 0, 'already tied: nothing new')
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

