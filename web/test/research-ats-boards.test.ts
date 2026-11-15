// MISSION v2 part E: public ATS job boards (lib/research/sources/ats-boards.ts) and the hunt hook that reads the boards the search found
// (lib/research/hunt.ts huntWithRegistry), on REAL recorded board answers (test/fixtures/research-ats-boards.json, 15 Nov 2026). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { boardApi, boardCandidate, boardCandidates, boardOf, boardRoles, placeTest, type Board } from '../lib/research/sources/ats-boards.ts'
import { huntWithRegistry } from '../lib/research/hunt.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import type { Candidate, ResearchCase } from '../lib/research/types.ts'

const FX = JSON.parse(readFileSync(new URL('./fixtures/research-ats-boards.json', import.meta.url), 'utf8')) as Record<'greenhouse' | 'ashby' | 'lever', { token: string; body: unknown }> & { lever_city: string }
const SINCE = '2026-08-17'
const AUSTIN: ResearchCase = { tenant: 't', jobId: 'j', query: 'chip startups in Austin', offer: 'x', where: 'Austin, Texas', category: 'semiconductor companies', windowDays: 90, today: '2026-11-15' }
const GH: Board = { ats: 'greenhouse', token: 'tenstorrent' }, AB: Board = { ats: 'ashby', token: 'expressable' }, LV: Board = { ats: 'lever', token: 'palantir' }

test('a search result names a board only on a board host; anything else (the company site, an aggregator, http) is not a board', () => {
  assert.deepEqual(boardOf('https://job-boards.greenhouse.io/tenstorrent/jobs/4651190007'), GH)
  assert.deepEqual(boardOf('https://boards.greenhouse.io/embed/job_board?for=Tenstorrent'), GH)
  assert.deepEqual(boardOf('https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd'), LV)
  assert.deepEqual(boardOf('https://jobs.eu.lever.co/acme'), { ats: 'lever', token: 'acme', host: 'eu' })
  assert.equal(boardOf('https://job-boards.eu.greenhouse.io/acme'), null, 'EU Greenhouse boards have another API host: not read rather than misread as missing')
  assert.deepEqual(boardOf('https://jobs.ashbyhq.com/expressable/34413f8d'), AB)
  for (const u of ['https://www.linkedin.com/jobs/view/1', 'https://tenstorrent.com/careers', 'http://jobs.lever.co/palantir', 'https://greenhouse.io/tenstorrent', 'not a url']) assert.equal(boardOf(u), null, u)
  assert.equal(boardApi(GH), 'https://boards-api.greenhouse.io/v1/boards/tenstorrent/jobs')
  assert.equal(boardApi({ ats: 'lever', token: 'acme', host: 'eu' }), 'https://api.eu.lever.co/v0/postings/acme?mode=json')
})

test("each board's own posting day and location, on real boards: only roles in the case's city and inside the window count", () => {
  const gh = boardRoles(GH, FX.greenhouse.body)!, ab = boardRoles(AB, FX.ashby.body)!, lv = boardRoles(LV, FX.lever.body)!
  assert.ok(gh.length === 11 && ab.length > 0 && lv.length > 0)
  assert.ok([...gh, ...ab, ...lv].every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.posted) && /^https:\/\//.test(r.url)))
  const t = boardCandidate(GH, gh, AUSTIN, SINCE)!
  // the recorded board holds 8 Austin roles, of which 3 were first posted inside the window (2026-11-12, 2026-11-06, 2026-10-08)
  assert.match(t.title, /^Tenstorrent: 3 open roles in Austin posted since 2026-08-17 \(Greenhouse job board\)$/)
  assert.equal(t.date, '2026-11-12'); assert.equal(t.via, 'registry'); assert.equal(t.dated, 'registry'); assert.equal(t.triggerId, 'registry:ats_open_roles')
  assert.match(t.url, /^https:\/\/job-boards\.greenhouse\.io\/tenstorrent\/jobs\/\d+$/)
  assert.match(t.snippet, /latest: Accounting Manager \(Austin, Texas/)
  assert.ok(boardCandidate(AB, ab, AUSTIN, SINCE)!.title.startsWith('Expressable: '), 'Ashby: the role\'s structured address locality')
  assert.equal(boardCandidate(GH, gh, { where: 'Denver, Colorado' }, SINCE), null, 'no role in the city: nothing')
  assert.equal(boardCandidate(GH, gh, AUSTIN, '2026-11-13'), null, 'no role inside the window: nothing')
  const city = FX.lever_city.split(',')[0]
  assert.ok(boardCandidate(LV, lv, { where: FX.lever_city }, '2026-01-01')?.title.startsWith(`Palantir: `), `Lever: ${city}`)
  assert.equal(boardRoles(LV, { ok: false, error: 'rate limited' }), null, 'a 200 without the board shape is unreadable, not empty')
  assert.equal(boardRoles(GH, { error: 'x' }), null)
})

test("the case's place, city AND region: another state's Austin, Port Austin and North Vancouver are other places", () => {
  const tx = placeTest({ where: 'Austin, Texas' })!
  assert.equal(tx('Austin, Texas, United States'), true); assert.equal(tx('Austin, TX'), true); assert.equal(tx('Remote - Austin, TX (Hybrid)'), true)
  assert.equal(tx('Texas; Austin'), false, 'the city and the region must be the same place'); assert.equal(tx('Austin, MN; Dallas, TX'), false)
  assert.equal(tx('Austin, MN'), false); assert.equal(tx('Port Austin, Texas'), false); assert.equal(tx('Remote'), false); assert.equal(tx('Austin'), false, 'no region on the role: not provably this Austin')
  const bc = placeTest({ where: 'Vancouver, British Columbia' })!
  assert.equal(bc('Vancouver, BC'), true); assert.equal(bc('Vancouver, WA'), false); assert.equal(bc('North Vancouver, BC'), false)
  assert.equal(placeTest({ where: 'Portland, Maine' })!('Portland, OR'), false)
  assert.equal(placeTest({ where: 'Portland, Oregon' })!('Portland, ME or Remote'), false)
  assert.equal(placeTest({ where: 'London, Ontario' })!('London, UK (on-site)'), false)
  assert.equal(placeTest({ where: 'Columbus, Indiana' })!('Columbus, OH (in office)'), false)
  assert.equal(placeTest({ where: 'Portland, Oregon' })!('Portland, OR'), true)
  assert.equal(placeTest({ where: 'Austin, Indiana' })!('Austin, In-Office'), false, 'a code is a token, never a word'); assert.equal(placeTest({ where: 'London, Ontario' })!('London, On-site'), false)
  assert.equal(placeTest({ where: 'Austin, Indiana' })!('Austin, IN (Hybrid)'), true); assert.equal(tx('Austin, TX 78701'), true)
  for (const l of ['Austin, TX - Hybrid', 'Austin, TX USA', 'Austin, TX · Remote', 'Austin, TX-', 'Austin, Texas - Remote', 'Austin, TX.', 'Austin, TX & Remote']) assert.equal(tx(l), true, l)
  assert.equal(placeTest({ where: 'Austin' }), null, 'a case without a region: which Austin is not known, nothing is provably there')
  assert.equal(placeTest({ where: 'Austin, USA' }), null, 'a country is not a region'); assert.equal(placeTest({ where: 'Toronto, Canada' }), null)
  assert.equal(placeTest({ where: 'San Francisco, CA' })!('San Francisco, CA'), true, 'CA is California, not Canada'); assert.equal(placeTest({ where: 'San Jose, CA' })!('San Jose, California, United States'), true)
  assert.equal(placeTest({ where: 'Portland, Oregon' })!('Portland, OR (Hybrid)'), true)
  const roles = [{ title: 'Roofer', location: 'Austin, MN', posted: '2026-11-01', url: 'https://jobs.lever.co/acme/1', company: null }]
  assert.equal(boardCandidate(LV, roles, AUSTIN, SINCE), null)
})

test('a case with no testable place asks no board at all and says so', async () => {
  let asked = 0
  const r = await boardCandidates({ ...AUSTIN, where: 'Austin' }, [{ url: 'https://jobs.lever.co/acme/1', title: '', snippet: '', date: null, triggerId: 't', query: 'q', via: 'tinyfish' }], SINCE, async () => { asked++; return { status: 200, body: '[]' } })
  assert.deepEqual(r, { candidates: [], notes: ['place_unknown'] }); assert.equal(asked, 0)
  let t = 0
  const slow = await boardCandidates(AUSTIN, [{ url: 'https://jobs.lever.co/a/1', title: '', snippet: '', date: null, triggerId: 't', query: 'q', via: 'tinyfish' }, { url: 'https://jobs.lever.co/b/1', title: '', snippet: '', date: null, triggerId: 't', query: 'q', via: 'tinyfish' }], SINCE,
    async () => { t += 20_000; return { status: 200, body: '[]' } }, undefined, { budgetMs: 15_000, now: () => t })
  assert.deepEqual(slow.notes, ['time_budget_reached'], 'board reads stop at their time budget')
})

test('the hook reads the boards the hunt found (one request per board), and a board record wins over the search hit for the same URL', async () => {
  const found: Candidate[] = [
    { url: 'https://job-boards.greenhouse.io/tenstorrent/jobs/1', title: 'a job', snippet: '', date: null, triggerId: 't1', query: 'q1', via: 'tinyfish' },
    { url: 'https://jobs.ashbyhq.com/expressable/abc', title: 'a job', snippet: '', date: null, triggerId: 't1', query: 'q2', via: 'tinyfish' },
    { url: 'https://jobs.ashbyhq.com/gone', title: 'x', snippet: '', date: null, triggerId: 't1', query: 'q3', via: 'tinyfish' },
    { url: 'https://news.example/austin-chips', title: 'news', snippet: '', date: '2026-10-01', triggerId: 't2', query: 'q4', via: 'tinyfish' },
  ]
  const asked: string[] = []
  const http: SafeGet = async u => {
    asked.push(u)
    if (u.includes('greenhouse')) return { status: 200, body: JSON.stringify(FX.greenhouse.body) }
    if (u.endsWith('/expressable')) return { status: 200, body: JSON.stringify(FX.ashby.body) }
    return { status: 404, body: '{}' }
  }
  const r = await boardCandidates(AUSTIN, found, SINCE, http)
  assert.equal(asked.length, 3); assert.deepEqual(r.notes, ['no_board_1'])
  assert.deepEqual(r.candidates.map(x => x.title.split(':')[0]).sort(), ['Expressable', 'Tenstorrent'])
  // through the hunt hook: the search's own hits are kept, the boards' records join them
  const plan = { persona: 'p', decisionMakerTitles: [], triggers: [{ id: 't1', name: 'n', why: '', footprint: '', queries: ['q'] }], askingQueries: [], source: 'fallback' as const }
  const search = async () => ({ ok: true as const, hits: found.map(f => ({ url: f.url, title: f.title, snippet: f.snippet, date: f.date })) })
  const h = await huntWithRegistry(AUSTIN, plan, search, http, { env: { LEAD_ENGINE: 'research' }, sources: [] })
  assert.equal(h.candidates.filter(x => x.via === 'tinyfish').length, 4)
  assert.equal(h.candidates.filter(x => x.dated === 'registry').length, 2); assert.equal(h.funnel.out, 6)
  assert.deepEqual(h.registry, { 'ats-boards': ['no_board_1'] })
  // a getter that throws outright: the search's candidates survive, the boards are a note
  const thrown = await huntWithRegistry(AUSTIN, plan, search, (() => { throw new Error('sync') }) as unknown as SafeGet, { env: { LEAD_ENGINE: 'research' }, sources: [] })
  assert.equal(thrown.candidates.length, 4); assert.equal(thrown.funnel.dropped['registry_ats-boards_error'], 1)
  assert.equal(h.funnel.dropped['registry_ats-boards_no_board_1'], 1, 'the note reaches the scan funnel')
  // the board's role page was also a search hit: one candidate, the board's dated record
  const tenstorrentLatest = r.candidates.find(x => x.title.startsWith('Tenstorrent'))!.url
  const sameUrl = async () => ({ ok: true as const, hits: [...found, { url: tenstorrentLatest, title: 'search hit', snippet: '', date: null }].map(f => ({ url: f.url, title: f.title, snippet: f.snippet, date: f.date })) })
  const h2 = await huntWithRegistry(AUSTIN, plan, sameUrl, http, { env: { LEAD_ENGINE: 'research' }, sources: [] })
  const at = h2.candidates.filter(x => x.url === tenstorrentLatest)
  assert.equal(at.length, 1); assert.equal(at[0].dated, 'registry'); assert.equal(h2.funnel.dropped.registry_record_over_hit, 1)
  const off = await huntWithRegistry(AUSTIN, plan, search, async () => { throw new Error('no request when off') }, { env: {} })
  assert.equal(off.candidates.length, 4)
})
