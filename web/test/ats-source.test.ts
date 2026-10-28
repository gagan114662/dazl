// Greenhouse / Lever / Ashby public job boards as a lead source: per-board progress rows in the same statuses the status route serves, and the seed-only / sales-hiring verifier gap
// (a board-sourced candidate proves hiring but not the funding round). Stubbed boards, pages, news and model only; postings and companies are INVENTED. No network, no key, no credits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectEvidenceReport } from '../lib/sources/index.ts'
import { atsKindOf } from '../lib/sources/jobboards.ts'
import { corroborationTargets } from '../lib/scan/corroborate.ts'
import { progressOf, outcomeInputs } from '../lib/scan/progress.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const ms = (n: number) => Date.now() - n * 86_400_000
const QUERY = 'London UK startups hiring sales account executives'
const LEVER = (host: string, n = 1) => Array.from({ length: n }, (_, i) => ({ text: 'Account Executive', hostedUrl: `https://jobs.lever.co/${host}/${i + 1}`, createdAt: ms(9), categories: { location: 'London, UK', allLocations: ['London, UK'] }, descriptionPlain: `${host} is hiring an Account Executive in London to sell to UK fintechs. ${'x'.repeat(40)}` }))
const GH = (t: string) => ({ jobs: [{ id: 1, title: 'Account Executive', location: { name: 'London, UK' } }] })
const GHD = (t: string) => ({ id: 1, title: 'Account Executive', first_published: new Date(ms(9)).toISOString(), absolute_url: `https://boards.greenhouse.io/${t}/jobs/1`, location: { name: 'London, UK' }, content: `&lt;p&gt;${t} is hiring an Account Executive in London to sell to UK fintechs. Join the sales team.&lt;/p&gt;` })
const ASHBY = (t: string) => ({ jobs: [{ isListed: true, title: 'Account Executive', jobUrl: `https://jobs.ashbyhq.com/${t}/1`, location: 'London, UK', publishedAt: new Date(ms(9)).toISOString(), descriptionPlain: `${t} is hiring an Account Executive in London to sell to UK fintechs. ${'x'.repeat(40)}` }] })
function http(map: Record<string, { status: number; body?: unknown } | null>): SafeGet {
  return async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return { status: 404, body: '' }
    const r = map[url]
    return r === undefined ? { status: 404, body: '' } : r === null ? null : { status: r.status, body: JSON.stringify(r.body ?? {}) }
  }
}
const SEL = (feeds: string[]) => ({ adapters: ['jobboards'], feeds, pages: [] as string[] })
const row = (runs: { collector: string; status: string; evidence: number | null }[], c: string) => runs.find(r => r.collector === c)

test('atsKindOf: only the three documented hosts', () => {
  assert.equal(atsKindOf('https://boards.greenhouse.io/x/jobs/1'), 'greenhouse'); assert.equal(atsKindOf('https://job-boards.greenhouse.io/x'), 'greenhouse')
  assert.equal(atsKindOf('https://jobs.lever.co/x/1'), 'lever'); assert.equal(atsKindOf('https://jobs.ashbyhq.com/x/1'), 'ashby')
  assert.equal(atsKindOf('https://evil.example/boards.greenhouse.io/x'), null); assert.equal(atsKindOf('not a url'), null)
})

test('PROGRESS: one row per ATS actually asked - ok with postings, empty with none (a plain 404), error when every request failed - alongside adapter:jobboards', async () => {
  const r = await collectEvidenceReport(SEL(['https://jobs.lever.co/acme', 'https://boards.greenhouse.io/beta', 'https://jobs.ashbyhq.com/gamma']), QUERY, http({
    'https://api.lever.co/v0/postings/acme?mode=json': { status: 200, body: LEVER('acme', 2) },
    'https://boards-api.greenhouse.io/v1/boards/beta/jobs': { status: 503 },
    // ashby gamma: default 404 = no such board, a normal answer
  }), 5000)
  assert.deepEqual([row(r.runs, 'ats:lever')?.status, row(r.runs, 'ats:lever')?.evidence], ['ok', 2])
  assert.deepEqual([row(r.runs, 'ats:greenhouse')?.status, row(r.runs, 'ats:greenhouse')?.evidence], ['error', null], 'a 503 is a failed request, not an empty board')
  assert.deepEqual([row(r.runs, 'ats:ashby')?.status, row(r.runs, 'ats:ashby')?.evidence], ['empty', 0], 'a 404 is a real answer: no such board')
  assert.ok(row(r.runs, 'adapter:jobboards'))
})
test('PROGRESS: some requests of one ATS failing is partial:<failed>_of_<asked>; unreachable and malformed 200s count as failed; nothing asked = no row', async () => {
  const r = await collectEvidenceReport(SEL(['https://jobs.lever.co/acme', 'https://jobs.lever.co/down', 'https://jobs.lever.co/odd']), QUERY, http({
    'https://api.lever.co/v0/postings/acme?mode=json': { status: 200, body: LEVER('acme') },
    'https://api.lever.co/v0/postings/down?mode=json': null,
    'https://api.lever.co/v0/postings/odd?mode=json': { status: 200, body: {} },
  }), 5000)
  assert.equal(row(r.runs, 'ats:lever')?.status, 'partial:2_of_3')
  assert.equal(row(r.runs, 'ats:greenhouse'), undefined, 'a board the adapter never asked has no row'); assert.equal(row(r.runs, 'ats:ashby'), undefined)
  // through the public progress / outcome mapping
  const rows = r.runs.map(x => ({ collector: x.collector, status: x.status, evidence_count: x.evidence, candidate_count: x.evidence ? 0 : null, verified_count: null, review_count: null }))
  const p = progressOf(rows, 'done').find(x => x.source === 'ats:lever')!
  assert.deepEqual([p.status, p.state, p.note], ['partial', 'done', '2 of 3 requests failed'])
  const o = scanOutcome({ id: 'j', status: 'failed', error: 'no_candidates', candidates: 0, verified: 0, needs_review: 0, dropped: 0, ...outcomeInputs(null, rows, 'failed') } as never)
  assert.notEqual(o.kind, 'zero_match'); assert.match((o.detail ?? '') + o.label, /ats:lever/)
})
test('PROGRESS: the three public APIs all answer through one adapter run; malformed Greenhouse JSON is a failed request', async () => {
  const r = await collectEvidenceReport(SEL(['https://boards.greenhouse.io/delta', 'https://jobs.ashbyhq.com/eps']), QUERY, http({
    'https://boards-api.greenhouse.io/v1/boards/delta/jobs': { status: 200, body: GH('delta') }, 'https://boards-api.greenhouse.io/v1/boards/delta/jobs/1': { status: 200, body: GHD('delta') },
    'https://api.ashbyhq.com/posting-api/job-board/eps': { status: 200, body: ASHBY('eps') },
  }), 5000)
  assert.deepEqual([row(r.runs, 'ats:greenhouse')?.status, row(r.runs, 'ats:ashby')?.status], ['ok', 'ok']); assert.equal(r.items.length, 2)
  const bad = await collectEvidenceReport(SEL(['https://boards.greenhouse.io/delta']), QUERY, http({ 'https://boards-api.greenhouse.io/v1/boards/delta/jobs': { status: 200, body: { nope: 1 } } }), 5000)
  assert.equal(row(bad.runs, 'ats:greenhouse')?.status, 'error')
})

// ---- the verifier gap ----
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const JOB = 'https://boards.greenhouse.io/brightloop/jobs/1'
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const JOBQ = 'Brightloop is hiring an Account Executive in London to sell to UK fintechs. Join the sales team'
const FUNDQ = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const filler = ' More about the company, its product and its people.'.repeat(10)
const jobCand: Cand = { company: 'Brightloop', signal: 'hiring a sales account executive', source_url: JOB, excerpt: JOBQ, event_date: daysAgo(9) }
const fundCand: Cand = { company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: FUNDQ, event_date: daysAgo(12) }
const gdelt = (articles: unknown[]) => JSON.stringify({ articles })
function fx(newsArticles: unknown[]): Fixture {
  const sourceHttp = http({ 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs': { status: 200, body: GH('brightloop') }, 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/1': { status: 200, body: GHD('brightloop') } })
  const newsHttp: SafeGet = async () => ({ status: 200, body: gdelt(newsArticles) })
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup hiring account executive'], hits: [{ url: JOB, title: 'Account Executive', snippet: JOBQ, date: daysAgo(9) }], tfPages: {},
    own: { [JOB]: { title: 'Account Executive at Brightloop', text: `Posted ${daysAgo(9)}. ${JOBQ}.${filler}` }, [NEWS]: { title: 'Brightloop raises seed round', text: `Published ${daysAgo(12)}. ${FUNDQ}.${filler}` } },
    extraction: [jobCand, fundCand], deps: { sourceHttp, newsHttp } }
}
const brightloop = (x: Awaited<ReturnType<typeof runFixture>>) => x.db.prepare("SELECT review_reason, confidence, source_url FROM leads WHERE company = 'Brightloop'").all() as { review_reason: string | null; confidence: number | null; source_url: string }[]

test('corroborationTargets: only a board-sourced company whose quote shows no funding round, capped, for a seed + sales request', () => {
  const job = { query: REQUEST, icp: JSON.stringify(ICP) }
  const t = corroborationTargets(job, [{ company: 'Brightloop', excerpt: JOBQ, signal: 'hiring' }, { company: 'Brightloop Ltd', excerpt: JOBQ, signal: 'hiring' }, { company: 'Orbit', excerpt: 'Orbit raised a seed round in London', signal: 'seed' }, ...['A1', 'B2', 'C3', 'D4'].map(c => ({ company: `Co ${c}`, excerpt: 'is hiring sales', signal: 'hiring' }))])
  assert.equal(t.length, 3); assert.ok(t.every(x => /raised seed funding round$/.test(x.query)), JSON.stringify(t)); assert.ok(!t.some(x => /Orbit/.test(x.company)), 'a quote that already shows the seed round needs no search')
  assert.deepEqual(corroborationTargets({ query: 'Find London UK startups hiring sales staff', icp: JSON.stringify({ ...ICP, signals: ['hiring sales staff'] }) }, [{ company: 'X', excerpt: JOBQ, signal: 'hiring' }]), [], 'a hiring-only request has no funding half')
})
test('VERIFIER GAP: a board-sourced Brightloop (hiring proven, no funding in the job ad) is corroborated by a news search whose funding quote passes the normal verifier -> qualifies; the ATS rows and corroborate:news show in progress', async () => {
  const x = await runFixture(fx([{ url: NEWS, title: 'Brightloop raises seed round', seendate: '20261016T100000Z' }]))
  const b = brightloop(x); assert.equal(b.length, 1, JSON.stringify(b)); assert.equal(b[0].review_reason, null, JSON.stringify(b)); assert.notEqual(b[0].confidence, null)
  const rows = sourceRuns(x.db, 'A', (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id) as { collector: string; status: string; candidate_count: number | null }[]
  assert.ok(rows.find(r => r.collector === 'corroborate:news' && r.status === 'ok'), JSON.stringify(rows)); assert.ok(rows.find(r => r.collector === 'ats:greenhouse'), 'a per-board row exists')
})
test('VERIFIER GAP: corroboration finds nothing -> Brightloop stays held with the specific reason no_event_evidence (hiring alone is not seed funding); the empty corroboration is its own row', async () => {
  const x = await runFixture(fx([]))
  const b = brightloop(x); assert.equal(b.length, 1, JSON.stringify(b)); assert.equal(b[0].review_reason, 'no_event_evidence', JSON.stringify(b)); assert.equal(b[0].confidence, null)
  const rows = sourceRuns(x.db, 'A', (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id) as { collector: string; status: string }[]
  assert.equal(rows.find(r => r.collector === 'corroborate:news')?.status, 'empty', JSON.stringify(rows))
})
