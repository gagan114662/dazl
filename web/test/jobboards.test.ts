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
const GH_DETAIL: Record<string, unknown> = { '1': { id: 1, title: 'Payroll Specialist', first_published: day(9), updated_at: day(1), location: { name: 'Columbus, OH' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' } }
const AB = { apiVersion: '1', jobs: [
  { title: 'HR Generalist', location: 'Cleveland, OH', isListed: true, publishedAt: day(12), address: { postalAddress: { addressRegion: 'Ohio' } }, jobUrl: 'https://jobs.ashbyhq.com/zed/1' },
  { title: 'HR Generalist', location: 'Cleveland, OH', isListed: false, publishedAt: day(12), address: { postalAddress: { addressRegion: 'Ohio' } }, jobUrl: 'https://jobs.ashbyhq.com/zed/2' },
  { title: 'HR Generalist', location: 'Cleveland, OH', isListed: true, publishedAt: day(200), address: { postalAddress: { addressRegion: 'Ohio' } }, jobUrl: 'https://jobs.ashbyhq.com/zed/3' },
  { title: 'HR Generalist', location: 'Remote', isListed: true, publishedAt: day(3), jobUrl: 'https://jobs.ashbyhq.com/zed/4' },
] }

function stub() {
  const seen: string[] = []
  const http: SafeGet = async url => {
    seen.push(url)
    const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs') return j(GH_LIST)
    const d = url.match(/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs\/(\d+)$/)
    if (d) return GH_DETAIL[d[1]] ? j(GH_DETAIL[d[1]]) : { status: 404, body: '' }
    if (url === 'https://api.ashbyhq.com/posting-api/job-board/zed') return j(AB)
    return null
  }
  return { http, seen }
}
const sel = (feeds: string[]) => ({ adapters: ['jobboards'], feeds, pages: [] })
const Q = 'ohio hiring payroll'
const QA = 'ohio hiring generalist'

test('Greenhouse: state and role filter on the list, the posting date comes from first_published (never updated_at), stale and undated dropped', async () => {
  const { http, seen } = stub()
  const ev = await collectEvidence(sel(['https://boards.greenhouse.io/acme']), Q, http, 5000)
  assert.deepEqual(ev.map(e => e.url), ['https://boards.greenhouse.io/acme/jobs/1'])
  assert.equal(ev[0].source, 'jobboards'); assert.equal(ev[0].date, day(9).slice(0, 10))
  assert.equal(ev[0].updated, day(1).slice(0, 10)) // context only
  // a detail request only for the one job that matched state and role
  assert.deepEqual(seen.filter(u => /jobs\/\d+$/.test(u)), ['https://boards-api.greenhouse.io/v1/boards/acme/jobs/1'])
})

test('Greenhouse: a matching job whose detail has no first_published is dropped, never dated from updated_at', async () => {
  GH_DETAIL['1'] = { id: 1, title: 'Payroll Specialist', updated_at: day(1), location: { name: 'Columbus, OH' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }
  const { http } = stub()
  const ev = await collectEvidence(sel(['https://boards.greenhouse.io/acme']), Q, http, 5000)
  assert.deepEqual(ev, [])
  GH_DETAIL['1'] = { id: 1, title: 'Payroll Specialist', first_published: day(9), updated_at: day(1), location: { name: 'Columbus, OH' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }
})

test('Ashby: listed only, state by region or ", OH", publishedAt within the window, remote without a state never matches', async () => {
  const { http } = stub()
  const ev = await collectEvidence(sel(['https://jobs.ashbyhq.com/zed']), QA, http, 5000)
  assert.deepEqual(ev.map(e => e.url), ['https://jobs.ashbyhq.com/zed/1'])
  assert.equal(ev[0].date, day(12).slice(0, 10))
})

test('no state in the profile means no evidence (never every state)', async () => {
  const { http, seen } = stub()
  assert.deepEqual(await collectEvidence(sel(['https://jobs.ashbyhq.com/zed']), 'hiring generalist', http, 5000), [])
  assert.equal(seen.length, 0)
})

test('only the two job-board API hosts are ever requested; blocked sources and lookalike hosts are never requested', async () => {
  const { http, seen } = stub()
  await collectEvidence(sel([
    'https://www.reddit.com/r/ohio/.json', 'https://opencorporates.com/companies/us_oh/1', 'https://businesssearch.ohiosos.gov/x',
    'https://index.commoncrawl.org/CC-MAIN-1', 'https://boards.greenhouse.io.evil.example/acme', 'https://boards.greenhouse.io/../etc',
    'https://boards.greenhouse.io/acme', 'https://jobs.ashbyhq.com/zed',
  ]), 'ohio hiring payroll generalist', http, 5000)
  assert.ok(seen.length >= 2)
  for (const u of seen) assert.ok(['boards-api.greenhouse.io', 'api.ashbyhq.com'].includes(new URL(u).hostname), u)
})

test('board tokens are validated: a token with path or query characters is never requested', async () => {
  const { http, seen } = stub()
  await collectEvidence(sel(['https://boards.greenhouse.io/ac%2Fme', 'https://boards.greenhouse.io/acme?x=1/../..', 'https://jobs.ashbyhq.com/z ed']), Q, http, 5000)
  assert.deepEqual(seen.filter(u => !u.endsWith('/acme/jobs')), [])
})
