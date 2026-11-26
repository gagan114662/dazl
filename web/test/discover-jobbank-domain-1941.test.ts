import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { resetFreeSiteFinderPacing } from '../lib/connectors/free-site-finder.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob } from '../lib/scan/store.ts'

// Production Job Bank posting identified in the #1941 export. HTML and search
// results are reconstructed fixtures; this test makes no live requests.
const company = 'The Tooth Corner'
const posting = 'https://www.jobbank.gc.ca/jobsearch/jobposting/50715766'
const quote = 'The Tooth Corner is hiring in Mississauga'
const searched = 'toothcornermississauga.example'

async function resolveDomain(t: TestContext, city: string, siteName = company, where = ['Mississauga, ON']) {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-26T12:00:00Z'))
  const settings = { SITECRAWL_ENABLED: '1', DAZL_FREE_SITE_FINDER: '1', DAZL_FREE_WEB_SEARCH: '1' }
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
  resetFreeSiteFinderPacing()
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  const master = randomBytes(32)
  saveKey(db, 'T', 'anthropic', 'sk-ant-fixture', master)
  const id = createQueryJob(db, 'T', { query: 'Dentists in Mississauga, ON', seller: 'Dental supplies' })
  db.prepare('UPDATE scan_jobs SET icp = ?, icp_inferred = 1 WHERE id = ?')
    .run(JSON.stringify({ who: ['Practice Manager'], where }), id)
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const found: DiscoverResult = {
    leads: [{
      company, domain: null, evidence_url: posting, evidence_quote: quote, signal: quote, signal_date: '2026-11-20',
      person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
      confidence: 'high', why: '',
    }],
    seen: [{ url: posting, title: company, page_age: null, text: `Posted on November 20, 2026. ${quote}.` }],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 },
    stop: 'end_turn', model: 'claude-opus-5-5', note: null,
  }
  const home = `https://${searched}/`
  const reads: string[] = []
  const searchRequests: string[] = []
  const pages: Record<string, string> = {
    [posting]: `<html><body><h1>${quote}</h1>${aggregatorOnly}</body></html>`,
    [`${home}robots.txt`]: 'User-agent: *\nAllow: /',
    [home]: `<html><body><h1>${siteName}</h1><p>100 Example Avenue, ${city}, Canada.</p>
      <p>Our dental practice welcomes local patients and families throughout the week.</p></body></html>`,
  }
  assert.equal(await runJob(db, job, {
    master, discover: true, discoverImpl: async () => found, enrichImpl: null,
    fetchImpl: async () => new Response('no paid requests in fixture', { status: 403 }),
    freeSiteFetch: async input => {
      const url = new URL(String(input))
      if (url.hostname === 'html.duckduckgo.com') {
        searchRequests.push(url.searchParams.get('q') ?? '')
        return new Response(`<a class="result__a" href="${home}">${company}</a>`)
      }
      return new Response(url.hostname === 'www.wikidata.org' ? '{"search":[]}' : '[]')
    },
    crawlGet: async url => {
      reads.push(url)
      return { status: pages[url] ? 200 : 404, body: pages[url] ?? '', finalUrl: url }
    },
  }), 'done')
  const saved = db.prepare('SELECT company_domain FROM leads WHERE scan_job_id = ?').get(id) as { company_domain: string | null } | undefined
  assert.ok(saved, 'the confirmed posting remains shown')
  return { domain: saved.company_domain, reads, searchRequests }
}

const aggregatorOnly = '<a href="https://www.indeed.com/viewjob?jk=fixture">Employer website</a>'

test('Discovery can resolve a domainless Job Bank lead through a company site in the same city', async t => {
  const result = await resolveDomain(t, 'Mississauga, ON L5B 1M1')
  assert.equal(result.domain, searched)
  assert.ok(result.reads.includes(`https://${searched}/`))
  assert.deepEqual(result.searchRequests, ['The Tooth Corner Mississauga, ON'])
})

test('Discovery refuses a same-named company site in a different city', async t => {
  const result = await resolveDomain(t, 'Vancouver, BC V6B 1A1')
  assert.equal(result.domain, null)
  assert.ok(result.reads.includes(`https://${searched}/`), 'the wrong-city candidate was actually read')
  assert.deepEqual(result.searchRequests, ['The Tooth Corner Mississauga, ON'])
})

test('Discovery refuses a matching-city site whose page names another employer', async t => {
  const result = await resolveDomain(t, 'Mississauga, ON L5B 1M1', 'Cedar Dental')
  assert.equal(result.domain, null)
  assert.ok(result.reads.includes(`https://${searched}/`), 'the wrong-company candidate was actually read')
})

test('Discovery does not use a province alone as the city for the free lookup', async t => {
  const result = await resolveDomain(t, 'Windsor, ON N9A 1A1', company, ['Ontario'])
  assert.equal(result.domain, null)
  assert.deepEqual(result.searchRequests, [])
})
