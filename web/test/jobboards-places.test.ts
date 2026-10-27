// ATS job boards for non-US places and the scan wiring. Every HTTP call is a stub (no live endpoint, no key); the postings are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { collectEvidence } from '../lib/sources/index.ts'
import { placeIn } from '../lib/sources/jobboards.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const BODY = 'Nimbus Analytics is hiring an Account Executive to build its UK sales team in London.'

test('placeIn: states, cities and countries; a location must name the place (Remote and look-alikes never match); a city never widens to its country or state', () => {
  assert.equal(placeIn('ohio hiring payroll')!.name, 'Ohio')
  const lon = placeIn('London UK B2B SaaS startups hiring sales staff')!
  assert.equal(lon.name, 'London', 'London UK is a London request, not the whole country')
  for (const l of ['London, UK', 'London', 'Greater London Area', 'London, England, United Kingdom']) assert.equal(lon.ok(l), true, l)
  for (const l of ['Remote', undefined, 'Londonderry, Northern Ireland', 'Paris, France', 'Ukraine', 'Manchester, United Kingdom', 'Birmingham, England', 'Remote - United Kingdom', 'England', 'London, Ontario, Canada']) assert.equal(lon.ok(l), false, String(l))
  const nyc = placeIn('Find companies in New York City hiring receptionists')!
  assert.equal(nyc.name, 'New York City')
  for (const l of ['New York, NY', 'New York City', 'NYC', 'Brooklyn, NY', 'Bronx, New York', 'New York, NY, United States']) assert.equal(nyc.ok(l), true, l)
  for (const l of ['Albany, New York', 'Buffalo, NY', 'Remote - New York', 'Upstate New York', 'Remote', undefined]) assert.equal(nyc.ok(l), false, String(l))
  assert.equal(placeIn('hiring a receptionist in the Bronx')!.ok('Bronx, NY'), true)
  const state = placeIn('hiring in New York state')!; assert.equal(state.name, 'New York', 'plain New York stays the state'); assert.equal(state.ok('Albany, New York'), true)
  const uk = placeIn('UK startups hiring sales')!
  assert.equal(uk.name, 'United Kingdom'); for (const l of ['Manchester, United Kingdom', 'Remote - United Kingdom', 'London, UK']) assert.equal(uk.ok(l), true, l); assert.equal(uk.ok('Paris, France'), false)
  assert.equal(placeIn('hiring sales staff'), null, 'no place named: no boards')
})

function board(published: number, location = 'London, UK') {
  const seen: string[] = []
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    seen.push(url)
    const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/nimbus/jobs') return j({ jobs: [
      { id: 1, title: 'Sales Account Executive', updated_at: day(1), location: { name: location }, absolute_url: 'https://boards.greenhouse.io/nimbus/jobs/1' },
      { id: 2, title: 'Account Executive', updated_at: day(1), location: { name: 'Paris, France' }, absolute_url: 'https://boards.greenhouse.io/nimbus/jobs/2' },
      { id: 3, title: 'Backend Engineer', updated_at: day(1), location: { name: 'London, UK' }, absolute_url: 'https://boards.greenhouse.io/nimbus/jobs/3' },
    ] })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/nimbus/jobs/1') return j({ id: 1, title: 'Sales Account Executive', first_published: day(published), updated_at: day(1), content: `&lt;p&gt;${BODY}&lt;/p&gt;`, location: { name: location }, absolute_url: 'https://boards.greenhouse.io/nimbus/jobs/1' })
    return null
  }
  return { http, seen }
}
const sel = { adapters: ['jobboards'], feeds: ['https://boards.greenhouse.io/nimbus'], pages: [] as string[] }

test('London: only the London sales posting is fetched and returned, dated from first_published; Paris and the engineering role are not', async () => {
  const { http, seen } = board(9)
  const ev = await collectEvidence(sel, 'London UK B2B SaaS startups hiring sales account executive', http, 5000)
  assert.deepEqual(ev.map(e => e.url), ['https://boards.greenhouse.io/nimbus/jobs/1']); assert.equal(ev[0].date, day(9).slice(0, 10)); assert.equal(ev[0].quote, BODY)
  assert.deepEqual(seen, ['https://boards-api.greenhouse.io/v1/boards/nimbus/jobs', 'https://boards-api.greenhouse.io/v1/boards/nimbus/jobs/1'], 'one detail request, only for the posting that matched place and role')
})
test('exact London/NYC requests through collectEvidence: Manchester, UK-remote, Albany and Buffalo postings are never fetched; matching city postings are', async () => {
  for (const [q, bad, good] of [['London UK startups hiring sales account executive', ['Manchester, United Kingdom', 'Remote - United Kingdom', 'Birmingham, England'], 'London, UK'], ['New York City companies hiring sales account executive', ['Albany, New York', 'Buffalo, NY', 'Upstate New York'], 'New York, NY']] as const) {
    for (const loc of bad) { const { http, seen } = board(9, loc); assert.equal((await collectEvidence(sel, q, http, 5000)).length, 0, loc); assert.ok(!seen.some(u => u.endsWith('/jobs/1')), `${loc}: no detail fetch`) }
    assert.equal((await collectEvidence(sel, q, board(9, good).http, 5000)).length, 1, good)
  }
})
test('the request\'s own window is used: 45 days old is out for "past 30 days", in for "past 120 days", and the default stays 90', async () => {
  assert.equal((await collectEvidence(sel, 'London hiring account executive in the past 30 days', board(45).http, 5000)).length, 0)
  assert.equal((await collectEvidence(sel, 'London hiring account executive in the past 120 days', board(45).http, 5000)).length, 1)
  assert.equal((await collectEvidence(sel, 'London hiring account executive', board(45).http, 5000)).length, 1)
  assert.equal((await collectEvidence(sel, 'London hiring account executive', board(120).http, 5000)).length, 0, 'default window is still 90 days')
})
test('no place in the request: nothing is requested at all', async () => {
  const { http, seen } = board(9)
  assert.deepEqual(await collectEvidence(sel, 'B2B SaaS startups hiring account executive', http, 5000), []); assert.deepEqual(seen, [])
})

// ---- wired into the scan: a hiring request with no explicit sources reads the boards its own search returned ----
const master = randomBytes(32); process.env.DAZL_MASTER_KEY = master.toString('base64')
test('runner: a hiring request auto-reads the public board found by search; the dated posting reaches extraction and is verified against its page; a request with no hiring signal does not', async () => {
  const run = async (query: string, signals: string[]) => {
    resetTinyfishState()
    const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
    saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
    db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT, business_name TEXT)'); db.prepare('INSERT INTO users VALUES (?, ?)').run('A', 'Acme')
    const icp = { summary: 'London SaaS hiring sales', who: ['Founder'], industries: [], sizes: [], where: ['London'], signals, exclude: [], country: 'GB', language: 'en' }
    createQueryJob(db, 'A', { query, icp: JSON.stringify(icp) })
    const job = claimKeyedJob(db)!
    const requested: string[] = []; const prompts: string[] = []
    const fetchImpl = (async (u: string) => {
      if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://boards.greenhouse.io/nimbus/jobs/9', title: 'Account Executive', snippet: 'Nimbus Analytics hiring an account executive in London for the sales team', date: day(8).slice(0, 10) }] }), { status: 200 })
      if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const sourceHttp: SafeGet = async (url) => { requested.push(url); return board(9).http(url) }
    const cand = { name: '', company: 'Nimbus Analytics', contact: null, signal: 'Hiring an account executive', source_url: 'https://boards.greenhouse.io/nimbus/jobs/1', score: 80, excerpt: BODY, event_date: day(9).slice(0, 10) }
    const providers: Record<'anthropic' | 'openai', Provider> = {
      anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string, _f?: typeof fetch, maxTokens?: number) => { prompts.push(p); return maxTokens === 300 ? '[]' : p.includes('/jobs/1') && p.includes('first_published') === false && p.includes(BODY) ? JSON.stringify([cand]) : '[]' } },
      openai: { research: async () => ({ text: '', citedUrls: [] }) },
    }
    const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl; process.env.TINYFISH_API_KEY = 'tf-test'
    try {
      await runJob(db, job, { providers, master, fetchImpl, sourceHttp, score: false, ground: false, judge: null, fetchPage: async (u: string) => u.endsWith('/jobs/1') ? { text: `Posted ${day(9).slice(0, 10)}. ${BODY} Apply now. ${'We are a small team.'.repeat(5)}`, title: 'Account Executive - Nimbus Analytics', retrievedAt: Math.floor(Date.now() / 1000) } : { fail: 'blocked' as const } })
      const leads = db.prepare('SELECT company, source_url, review_reason FROM leads').all() as { company: string; source_url: string; review_reason: string | null }[]
      return { leads, requested, prompts }
    } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
  }
  const hiring = await run('London UK B2B SaaS startups with 10-50 employees hiring sales staff', ['hiring sales staff'])
  assert.ok(hiring.requested.includes('https://boards-api.greenhouse.io/v1/boards/nimbus/jobs'), hiring.requested.join('\n'))
  assert.ok(hiring.prompts.some(p => p.includes(BODY) && p.includes('jobboards')), 'the dated board posting was given to extraction')
  assert.deepEqual(hiring.leads.filter(l => !l.review_reason).map(l => l.company), ['Nimbus Analytics'])
  const none = await run('London UK B2B SaaS startups that announced seed funding', ['announced seed funding'])
  assert.deepEqual(none.requested, [], 'no hiring signal: the boards are not touched')
})
