// Job-board adapter fixtures: Greenhouse and Ashby public job JSON, filtered by state and role. All HTTP is a stub; no live endpoint.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectEvidence } from '../lib/sources/index.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const GH_LIST = { jobs: [
  { id: 1, title: 'Payroll Specialist', updated_at: day(1), location: { name: 'Columbus, OH' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' },
  { id: 2, title: 'Payroll Specialist', updated_at: day(1), location: { name: 'Austin, TX' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/2' },
  { id: 3, title: 'Software Engineer', updated_at: day(1), location: { name: 'Columbus, Ohio' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/3' },
  { id: 4, title: 'Payroll Manager', updated_at: day(1), location: { name: 'Cohoes, NY' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/4' },
] }
const BODY = 'Acme runs payroll for four hundred hourly staff and needs a specialist to own it.'
const ghDetail = (withDate = true): Record<string, unknown> => ({ '1': { id: 1, title: 'Payroll Specialist', ...(withDate ? { first_published: day(9) } : {}), updated_at: day(1), content: `&lt;p&gt;${BODY}&lt;/p&gt;`, location: { name: 'Columbus, OH' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' } })
let GH_DETAIL = ghDetail()
const ABODY = 'Zed Corp is hiring an HR generalist to run onboarding for its Cleveland office.'
const AB = { apiVersion: '1', jobs: [
  { title: 'HR Generalist', location: 'Cleveland, OH', isListed: true, descriptionPlain: ABODY, publishedAt: day(12), address: { postalAddress: { addressRegion: 'Ohio' } }, jobUrl: 'https://jobs.ashbyhq.com/zed/1' },
  { title: 'HR Generalist', location: 'Cleveland, OH', isListed: false, publishedAt: day(12), address: { postalAddress: { addressRegion: 'Ohio' } }, jobUrl: 'https://jobs.ashbyhq.com/zed/2' },
  { title: 'HR Generalist', location: 'Cleveland, OH', isListed: true, publishedAt: day(200), address: { postalAddress: { addressRegion: 'Ohio' } }, jobUrl: 'https://jobs.ashbyhq.com/zed/3' },
  { title: 'HR Generalist', location: 'Remote', isListed: true, publishedAt: day(3), jobUrl: 'https://jobs.ashbyhq.com/zed/4' },
] }

function stub() {
  const seen: string[] = []
  const hn: string[] = [] // Hacker News discovery requests, asserted separately (stub serves nothing)
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') { hn.push(url); return null }
    seen.push(url)
    const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs') return j(GH_LIST)
    const d = url.match(/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs\/(\d+)$/)
    if (d) return GH_DETAIL[d[1]] ? j(GH_DETAIL[d[1]]) : { status: 404, body: '' }
    if (url === 'https://api.ashbyhq.com/posting-api/job-board/zed') return j(AB)
    return null
  }
  return { http, seen, hn }
}
const sel = (feeds: string[]) => ({ adapters: ['jobboards'], feeds, pages: [] })
const Q = 'ohio hiring payroll'
const QA = 'ohio hiring generalist'

test('Greenhouse: state and role filter on the list, the posting date comes from first_published (never updated_at), stale and undated dropped', async () => {
  const { http, seen } = stub()
  const ev = await collectEvidence(sel(['https://boards.greenhouse.io/acme']), Q, http, 5000)
  assert.deepEqual(ev.map(e => e.url), ['https://boards.greenhouse.io/acme/jobs/1'])
  assert.equal(ev[0].source, 'jobboards'); assert.equal(ev[0].date, day(9).slice(0, 10)); assert.equal(ev[0].quote, BODY)
  assert.equal(ev[0].updated, day(1).slice(0, 10)) // context only
  // a detail request only for the one job that matched state and role
  assert.deepEqual(seen.filter(u => /jobs\/\d+$/.test(u)), ['https://boards-api.greenhouse.io/v1/boards/acme/jobs/1'])
})

test('Greenhouse: a matching job whose detail has no first_published is dropped, never dated from updated_at', async () => {
  GH_DETAIL = ghDetail(false)
  try {
    const { http } = stub()
    const ev = await collectEvidence(sel(['https://boards.greenhouse.io/acme']), Q, http, 5000)
    assert.deepEqual(ev, [])
  } finally { GH_DETAIL = ghDetail() }
})

test('Ashby: listed only, state by region or ", OH", publishedAt within the window, remote without a state never matches', async () => {
  const { http } = stub()
  const ev = await collectEvidence(sel(['https://jobs.ashbyhq.com/zed']), QA, http, 5000)
  assert.deepEqual(ev.map(e => e.url), ['https://jobs.ashbyhq.com/zed/1'])
  assert.equal(ev[0].date, day(12).slice(0, 10)); assert.equal(ev[0].quote, ABODY)
})

test('no state in the profile means no evidence (never every state)', async () => {
  const { http, seen } = stub()
  assert.deepEqual(await collectEvidence(sel(['https://jobs.ashbyhq.com/zed']), 'hiring generalist', http, 5000), [])
  assert.equal(seen.length, 0)
})

test('only the two job-board API hosts are ever requested; blocked sources and lookalike hosts are never requested', async () => {
  const { http, seen, hn } = stub()
  await collectEvidence(sel([
    'https://www.reddit.com/r/ohio/.json', 'https://opencorporates.com/companies/us_oh/1', 'https://businesssearch.ohiosos.gov/x',
    'https://index.commoncrawl.org/CC-MAIN-1', 'https://boards.greenhouse.io.evil.example/acme', 'https://boards.greenhouse.io/../etc',
    'https://boards.greenhouse.io/acme', 'https://jobs.ashbyhq.com/zed',
  ]), 'ohio hiring payroll generalist', http, 5000)
  assert.ok(seen.length >= 2)
  assert.ok(hn.length >= 1 && hn.every(u => new URL(u).hostname === 'hn.algolia.com'))
  for (const u of seen) assert.ok(['boards-api.greenhouse.io', 'api.ashbyhq.com'].includes(new URL(u).hostname), u)
})

test('board tokens are validated: a token with path or query characters is never requested', async () => {
  const { http, seen } = stub()
  await collectEvidence(sel(['https://boards.greenhouse.io/ac%2Fme', 'https://boards.greenhouse.io/acme?x=1/../..', 'https://jobs.ashbyhq.com/z ed']), Q, http, 5000)
  assert.deepEqual(seen.filter(u => !u.endsWith('/acme/jobs')), [])
})

test('discovery: boards are derived from hit/page URLs (job posting links), deduped with feeds, lookalikes ignored', async () => {
  const { http, seen } = stub()
  const s = { adapters: ['jobboards'], feeds: ['https://boards.greenhouse.io/acme'], pages: [
    'https://boards.greenhouse.io/acme/jobs/1', 'https://jobs.ashbyhq.com/zed/1', 'https://boards.greenhouse.io.evil.example/ghost/jobs/9', 'https://example.com/boards.greenhouse.io/ghost/jobs/9',
  ] }
  const ev = await collectEvidence(s, 'ohio hiring payroll generalist', http, 5000)
  assert.deepEqual(ev.map(e => e.url).sort(), ['https://boards.greenhouse.io/acme/jobs/1', 'https://jobs.ashbyhq.com/zed/1'])
  assert.equal(seen.filter(u => u === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs').length, 1) // acme requested once
  assert.ok(!seen.some(u => u.includes('ghost')))
})

test('subdomain pin: x.boards.greenhouse.io and x.jobs.ashbyhq.com are never requested', async () => {
  const { http, seen } = stub()
  await collectEvidence(sel(['https://x.boards.greenhouse.io/acme', 'https://x.jobs.ashbyhq.com/zed', 'https://boards.greenhouse.io:8443/acme']), Q, http, 5000)
  assert.deepEqual(seen, [])
})

test('real Ashby shape: address region is the state abbreviation alone (as the live API returns it), location has no state text', async () => {
  const body = { jobs: [{ title: 'HR Generalist', location: 'Global HQ', isListed: true, descriptionPlain: ABODY, publishedAt: day(5), address: { postalAddress: { addressRegion: 'OH', addressCountry: 'USA' } }, jobUrl: 'https://jobs.ashbyhq.com/zed/9' }] }
  const http: SafeGet = async url => url === 'https://api.ashbyhq.com/posting-api/job-board/zed' ? { status: 200, body: JSON.stringify(body) } : null
  const ev = await collectEvidence(sel(['https://jobs.ashbyhq.com/zed']), QA, http, 5000)
  assert.deepEqual(ev.map(e => e.url), ['https://jobs.ashbyhq.com/zed/9'])
})

test('a region abbreviation of another state does not match, and neither does an abbreviation embedded in a word', async () => {
  const mk = (region: string) => ({ jobs: [{ title: 'HR Generalist', location: 'HQ', isListed: true, descriptionPlain: ABODY, publishedAt: day(5), address: { postalAddress: { addressRegion: region } }, jobUrl: 'https://jobs.ashbyhq.com/zed/9' }] })
  for (const region of ['NY', 'Ohiopyle', 'OHX']) {
    const http: SafeGet = async () => ({ status: 200, body: JSON.stringify(mk(region)) })
    assert.deepEqual(await collectEvidence(sel(['https://jobs.ashbyhq.com/zed']), QA, http, 5000), [], region)
  }
})
