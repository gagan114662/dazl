// #1102 / #1037 the grounded named-person step of a scan (lib/people/grounded-people.ts): one lookup per lead that still names nobody, ready leads
// first. Where it looks depends on what the lead has: its confirmed website; else the site its own source page is on; else that source page alone.
// Never for a lead the crawl already named or a hold that puts the company in doubt; a person is stored only when the lookup keeps one, with its
// source. TEST-ONLY fixtures: invented companies and people in the shapes of real scans (2026-11-14); TinyFish and the model are stubbed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addEnrichment } from '../lib/connectors/store.ts'
import { findGroundedPeople, GROUNDED_CONNECTOR, newGroundedStats, sourceOwnSite } from '../lib/people/grounded-people.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import { CONTACT_RESEARCH_MODEL } from '../lib/people/contact-research.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { setup, env, HELD_WHO, type Row } from './helpers/people-held-fixture.ts'

const ROWS: Row[] = [
  ['L-a', 'Pagewake', null, 90],               // ready, names nobody: looked up
  ['L-b', 'Meshgate', null, 80],               // ready, the crawl already named its Head of Sales: no lookup
  ['L-c', 'Surveyhive', 'place_mismatch', 70], // held with the company in doubt: no lookup
]
const TEAM = { url: 'https://pagewake.example/team', title: 'Our team | Pagewake', snippet: 'Dana Okoye, Head of Sales at Pagewake in Chicago, Illinois, leads our revenue team.' }
const DANA = { person: { name: 'Dana Okoye', title: 'Head of Sales', source: 'S1', quote: 'Dana Okoye, Head of Sales at Pagewake', linkedin_source: null } }
const NO_STATS = { eligible: 0, own_source: 0, source_page: 0, no_website: 0, looked_up: 0, found: 0, none: 0, refused: {}, failed: {} }
function harness(answer: unknown, page = '') {
  const calls = { searched: [] as string[], read: [] as string[], prompts: 0 }
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    const url = new URL(String(u))
    if (url.hostname !== 'api.search.tinyfish.ai') { const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []; calls.read.push(...urls); return new Response(JSON.stringify({ results: page ? urls.map(x => ({ url: x, title: 'Pagewake expands', text: page })) : [] })) }
    const q = url.searchParams.get('query') ?? ''; calls.searched.push(/^site:(\S+)/.exec(q)?.[1] ?? /^"([^"]+)"/.exec(q)?.[1] ?? q); return new Response(JSON.stringify({ results: [TEAM] }))
  }) as unknown as typeof fetch
  const provider: Provider = { research: async () => { throw new Error('never') }, configuredModel: () => CONTACT_RESEARCH_MODEL, completeDetailed: async () => { calls.prompts++; return { text: JSON.stringify(answer), model: CONTACT_RESEARCH_MODEL, usage: { input_tokens: 1500, output_tokens: 120 } } } }
  return { calls, opts: { provider, apiKey: 'sk-test', env, fetchImpl } }
}
type DB = ReturnType<typeof setup>['db']
const personRows = (db: DB, id: string) => db.prepare("SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND kind = 'person'").all(id) as { connector: string; kind: string; value: string; label: string; source_url: string }[]
const foundOn = (db: DB, id: string, url: string) => db.prepare('UPDATE leads SET source_url = ? WHERE id = ?').run(url, id)

test('#1102 a lead with a confirmed website that names nobody gets one lookup (its own site, then the open web) and the kept person is stored with its source', async () => {
  const { db, job } = setup(ROWS)
  addEnrichment(db, 'A', 'L-b', { connector: 'sitecrawl', kind: 'person', value: 'Lee Park, Head of Sales', label: 'company site', confidence: null, source_url: 'https://meshgate.example/team', source_date: '2026-11-14', retrieved_at: 1 })
  const h = harness(DANA)
  const stats = newGroundedStats()
  const n = await findGroundedPeople(db, 'A', job, { ...h.opts, stats })
  assert.equal(n, 1); assert.equal(h.calls.prompts, 1, 'one model call, for Pagewake only')
  assert.deepEqual([...new Set(h.calls.searched)], ['pagewake.example', 'Pagewake'], 'no search for the named lead or the in-doubt hold')
  assert.deepEqual(stats, { ...NO_STATS, eligible: 1, looked_up: 1, found: 1 })
  const rows = personRows(db, 'L-a')
  assert.equal(rows.length, 1); assert.equal(rows[0].connector, GROUNDED_CONNECTOR); assert.equal(rows[0].value, 'Dana Okoye, Head of Sales'); assert.equal(rows[0].source_url, TEAM.url)
  const p = leadPerson(db.prepare("SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = 'L-a' AND kind IN ('person','contact')").all(), HELD_WHO.join('; '))
  assert.equal(p?.name, 'Dana Okoye', 'the lead now names its person')
  assert.equal(personRows(db, 'L-c').length, 0)
})

test('#1102 a person the sources do not support is not stored (the model named someone the result never mentions)', async () => {
  const { db, job } = setup(ROWS)
  const h = harness({ person: { name: 'Riley Quinn', title: 'Head of Sales', source: 'S1', quote: 'Riley Quinn, Head of Sales at Pagewake', linkedin_source: null } })
  const stats = newGroundedStats()
  assert.equal(await findGroundedPeople(db, 'A', job, { ...h.opts, stats }), 0)
  assert.equal(personRows(db, 'L-a').length, 0); assert.equal(stats.found, 0)
  assert.equal(stats.looked_up, 2, 'both ready leads name nobody here'); assert.equal(Object.values(stats.refused).reduce((a, b) => a + b, 0), 2, 'each refused in code, with a reason')
})

test('#1102 a job of another tenant is never read, and a lost job writes nothing', async () => {
  const { db, job } = setup(ROWS)
  const h = harness(DANA)
  assert.equal(await findGroundedPeople(db, 'B', job, h.opts), 0); assert.equal(h.calls.prompts, 0)
  assert.equal(await findGroundedPeople(db, 'A', job, { ...h.opts, alive: () => false }), 0); assert.equal(personRows(db, 'L-a').length, 0)
})

test('#1037 no website, and a source page that is never requested (LinkedIn, or a page that refused the scan): no search, no read, no model call, counted', async () => {
  // The most common real case: the lead was found on a LinkedIn job post and has no recorded website.
  const { db, job } = setup([['L-a', 'Pagewake', 'quote_unconfirmed', 90], ['L-b', 'Meshgate', 'blocked_by_site', 80]], undefined, { domains: false })
  foundOn(db, 'L-a', 'https://www.linkedin.com/jobs/view/estimator-at-pagewake-4471969325'); foundOn(db, 'L-b', 'https://www.jobboard.example/job/meshgate/estimator')
  const h = harness(DANA, 'Dana Okoye, Head of Sales at Pagewake, said the team is growing.')
  const stats = newGroundedStats()
  assert.equal(await findGroundedPeople(db, 'A', job, { ...h.opts, stats }), 0)
  assert.equal(h.calls.searched.length, 0); assert.equal(h.calls.read.length, 0); assert.equal(h.calls.prompts, 0)
  assert.deepEqual(stats, { ...NO_STATS, no_website: 2 })
})

test('#1037 a lead found on its company\'s own site, whose page blocked the scan, has no recorded website: its own site is searched (never read) and the person is kept', async () => {
  // The real case (austin-roofing, 2026-11-14): source https://<company>.com/careers, held blocked_by_site, company_domain empty.
  const { db, job } = setup([['L-a', 'Pagewake', 'blocked_by_site', 90]], undefined, { domains: false })
  foundOn(db, 'L-a', 'https://www.pagewake.example/careers')
  const h = harness(DANA)
  const stats = newGroundedStats()
  assert.equal(await findGroundedPeople(db, 'A', job, { ...h.opts, stats }), 1)
  assert.deepEqual(stats, { ...NO_STATS, eligible: 1, own_source: 1, looked_up: 1, found: 1 })
  assert.equal(h.calls.searched[0], 'pagewake.example'); assert.equal(h.calls.read.length, 0, 'a site that refused the scan is not requested again')
  assert.equal(personRows(db, 'L-a')[0]?.value, 'Dana Okoye, Head of Sales')
})

test('#1037 a lead found on a press release or news story, with no website: that page alone is read (no search) and a person it ties to the company is kept', async () => {
  // The real case (chicago-law, 2026-11-14): "<Name>, managing partner of the Chicago office, added, ..." in the story the lead was found on.
  const STORY = 'https://news.example.test/pagewake-expands-chicago-office'
  const page = 'Pagewake added partners Sam Lee and Kim Park to its newly opened Chicago office. "Their arrivals mark a significant step," Alden Marsh, chair of Pagewake\'s executive committee, said. Dana Okoye, Head of Sales of the Chicago office, added, "Our Chicago team is growing." Lee said, "Pagewake is a premier destination."'
  const { db, job } = setup([['L-a', 'Pagewake', null, 90]], undefined, { domains: false })
  foundOn(db, 'L-a', STORY)
  const h = harness({ person: { name: 'Dana Okoye', title: 'Head of Sales', source: 'S1', quote: 'Dana Okoye, Head of Sales of the Chicago office, added', linkedin_source: null } }, page)
  const stats = newGroundedStats()
  assert.equal(await findGroundedPeople(db, 'A', job, { ...h.opts, stats }), 1)
  assert.deepEqual(stats, { ...NO_STATS, eligible: 1, source_page: 1, looked_up: 1, found: 1 })
  assert.equal(h.calls.searched.length, 0, 'nothing a search returns could be tied to a company with no website'); assert.deepEqual(h.calls.read, [STORY])
  assert.deepEqual(personRows(db, 'L-a').map(r => [r.value, r.source_url]), [['Dana Okoye, Head of Sales', STORY]])
  // The same story quoting someone from ANOTHER organisation: not kept.
  const other = setup([['L-a', 'Pagewake', null, 90]], undefined, { domains: false }); foundOn(other.db, 'L-a', STORY)
  const h2 = harness({ person: { name: 'Riley Quinn', title: 'Head of Sales', source: 'S1', quote: 'Riley Quinn, Head of Sales at Northgate Capital, said', linkedin_source: null } }, 'Pagewake opened a Chicago office. Riley Quinn, Head of Sales at Northgate Capital, said the move was expected.')
  assert.equal(await findGroundedPeople(other.db, 'A', other.job, h2.opts), 0); assert.equal(personRows(other.db, 'L-a').length, 0)
  // ... and a person the story names with no company or unit next to the title: not kept.
  const bare = setup([['L-a', 'Pagewake', null, 90]], undefined, { domains: false }); foundOn(bare.db, 'L-a', STORY)
  const h3 = harness({ person: { name: 'Riley Quinn', title: 'Head of Sales', source: 'S1', quote: 'Riley Quinn, Head of Sales, said', linkedin_source: null } }, 'Pagewake opened a Chicago office this week. Riley Quinn, Head of Sales, said the market was strong for everyone in the region.')
  assert.equal(await findGroundedPeople(bare.db, 'A', bare.job, h3.opts), 0)
})

test('#1037 the source page is the company\'s own site only when its host is named after the company', () => {
  assert.equal(sourceOwnSite('HD Roofing & Repairs', 'https://hdroofingandrepairs.example/careers'), 'hdroofingandrepairs.example', '"&" is "and" in a host name')
  assert.equal(sourceOwnSite('Pagewake', 'https://www.pagewake.example/jobs/'), 'pagewake.example')
  for (const u of ['https://www.linkedin.com/jobs/view/estimator-at-pagewake-1', 'https://www.career.com/job/pagewake/estimator', 'https://jobs.example.test/pagewake', 'https://pagewake.jobboard.example/x', 'not a url', null])
    assert.equal(sourceOwnSite('Pagewake', u), null, String(u))
})
