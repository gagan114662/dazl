// Part F's hunt adapter (MISSION v2, Hermes 15 Nov 06:13 "(a) discovery only"): public LinkedIn / X posts discover leads; the evidence is an openable
// page. Run through the real hunt() with a fake search, so the budget, rate-retry and refusal behaviour are the hunt's own.
// TEST-ONLY: invented companies and people; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { hunt, type SearchFn } from '../lib/research/hunt.ts'
import { derivedQuery, guardedSearch, huntSourcesFromEnv, linkedinPostsSource, newDiscoveryState } from '../lib/research/sources/linkedin-discovery.ts'
import type { ResearchCase, ResearchPlan } from '../lib/research/types.ts'

const liId = (day: string) => (BigInt(Date.parse(`${day}T12:00:00Z`)) << BigInt(22)).toString()
const liPost = (handle: string, day: string, slug = 'post') => `https://www.linkedin.com/posts/${handle}_${slug}-activity-${liId(day)}-AbCd`
const CASE: ResearchCase = { tenant: 't', jobId: 'j', query: 'Marketing agencies in Sydney posting about outbound', offer: 'Managed cold email infrastructure', where: 'Sydney, Australia', category: 'marketing agencies', windowDays: 90, today: '2026-11-15' }
const PLAN: ResearchPlan = { persona: 'agency founders', decisionMakerTitles: ['Founder'], source: 'fallback', askingQueries: [],
  triggers: [{ id: 't1', name: 'outbound posts', why: '', footprint: '', queries: ['cold email agency Sydney', 'outbound lead generation agency Sydney'] }] }
const hit = (url: string, title: string, snippet: string, date: string | null = null) => ({ url, title, snippet, date })

test('derivedQuery: what a post says, without platform noise; too little text is no query; the city is added once', () => {
  assert.equal(derivedQuery({ title: "Vurell's Post", snippet: 'Uplift Sales is a phone-only agency calling from Sydney, so these rules shape every campaign we set up. ... Co' }, 'Sydney, Australia'),
    'Uplift Sales is a phone-only agency calling from Sydney so these rules', 'the "<Name>\'s Post" title is skipped, the snippet used; Sydney is already there')
  assert.equal(derivedQuery({ title: 'SendTech Launches Email Infrastructure for Deliverability', snippet: 'Excited to launch our newest platform https://t.co/x #coldemail @sendtech \u{1F680}' }, 'Sydney, Australia'),
    'SendTech Launches Email Infrastructure for Deliverability Excited to launch our newest platform Sydney')
  assert.equal(derivedQuery({ title: "Dana's Post", snippet: 'Great day! #hiring' }, 'Sydney, Australia'), null, 'too little text')
  assert.equal(derivedQuery({ title: 'A title', snippet: 'the and of to in on' }, 'Sydney, Australia'), null, 'stop words only')
})

test('guardedSearch: a rate answer is retried after a pause and not counted as sent; a throw stops later calls and is rethrown', async () => {
  const waits: number[] = []
  let n = 0
  const g = guardedSearch(async () => (++n < 3 ? { ok: false, reason: 'rate' } : { ok: true, hits: [] }), { wait: async ms => { waits.push(ms) }, waitMs: 100, jitter: () => 0 })
  assert.deepEqual(await g.call('q', '2026-08-01'), { ok: true, hits: [] })
  assert.deepEqual(waits, [100, 100]); assert.equal(g.sent(), 1); g.rethrow()
  class Refused extends Error {}
  let calls = 0
  const h = guardedSearch(async () => { calls++; throw new Refused('spend') })
  assert.equal((await h.call('a', 'x')).ok, false)
  assert.equal((await h.call('b', 'x')).ok, false)
  assert.equal(calls, 1, 'nothing is sent after a refusal')
  assert.throws(() => h.rethrow(), Refused)
  const d = guardedSearch(async () => ({ ok: true, hits: [] }), { deadline: 1, now: () => 2 })
  assert.deepEqual(await d.call('q', 'x'), { ok: false, reason: 'deadline' })
})

// a fake web: hunt's own queries return one web page; the post queries return posts; a derived search returns openable pages (+ a LinkedIn one)
const fakeSearch = (log: string[]): SearchFn => async (q) => {
  log.push(q)
  if (q.startsWith('site:linkedin.com/posts')) return { ok: true, hits: [
    hit(liPost('uplift-sales', '2026-11-10'), "Uplift Sales's Post", 'Uplift Sales is a phone-only agency calling from Sydney, so these rules shape every campaign we set up.'),
    hit(liPost('sendtech', '2026-10-20'), 'SendTech Launches Email Infrastructure for Deliverability', 'Excited to launch our newest platform for agencies running cold email at scale.'),
    hit(liPost('thin', '2026-10-21'), "Thin's Post", 'Great day!')] }
  if (q.startsWith('site:x.com')) return { ok: true, hits: [] }
  if (/^Uplift Sales/.test(q)) return { ok: true, hits: [hit('https://upliftsales.example/about', 'About Uplift Sales', 'Phone-only outbound agency, Sydney', '2026-11-02'), hit('https://www.linkedin.com/company/uplift-sales', 'Uplift Sales', ''), hit('https://news.example/uplift', 'Uplift Sales opens a Sydney call centre', 'x', null)] }
  if (/^SendTech/.test(q)) return { ok: true, hits: [hit('https://sendtech.example/launch', 'SendTech launches', 'x', '2026-09-28'), hit('https://upliftsales.example/about', 'dup of an earlier page', 'x')] }
  return { ok: true, hits: [hit('https://web.example/agency-1', 'A Sydney agency', 'x', '2026-10-01')] }
}

test('hunt with the linkedin-posts source: posts become one search each; openable results are Candidates with the post\'s trigger; stats and budget are counted', async () => {
  const log: string[] = []
  const r = await hunt(CASE, PLAN, fakeSearch(log), { sources: [linkedinPostsSource()], wait: async () => {}, concurrency: 1 })
  const eng = r.candidates.filter(c => c.via === 'engager')
  assert.deepEqual(eng.map(c => c.url).sort(), ['https://news.example/uplift', 'https://sendtech.example/launch', 'https://upliftsales.example/about'].sort())
  assert.ok(eng.every(c => c.triggerId === 't1' && c.dated === undefined), 'the post\'s trigger; never a registry record')
  assert.equal(eng.find(c => c.url.endsWith('/launch'))!.date, '2026-09-28')
  assert.ok(!r.candidates.some(c => /linkedin\.com|x\.com/.test(c.url)), 'no LinkedIn or X URL becomes a Candidate')
  const s = r.sources![0]
  assert.equal(s.id, 'linkedin-posts'); assert.equal(s.in, 3); assert.equal(s.out, 3)
  assert.equal(s.dropped['unopenable host'], 1); assert.equal(s.dropped['too little text to search'], 1); assert.equal(s.dropped['same url'], 1)
  // the budget is the hunt's own search: hunt queries + post queries (2 queries x 2 platforms, capped at 6) + one derived search per usable post
  assert.equal(s.searches, log.filter(q => q.startsWith('site:') || /^(?:Uplift|SendTech)/.test(q)).length)
  assert.equal(log.length, r.queries + s.searches)
  assert.equal(log.filter(q => /^(?:Uplift|SendTech)/.test(q)).length, 2, 'the thin post is not searched')
})

test('the hunt without sources is unchanged: no `sources` field, no extra search', async () => {
  const log: string[] = []
  const r = await hunt(CASE, PLAN, fakeSearch(log), { sources: [], wait: async () => {} })
  assert.equal(r.sources, undefined); assert.equal(log.length, r.queries)
  assert.deepEqual(huntSourcesFromEnv({}), []); assert.deepEqual(huntSourcesFromEnv({ RESEARCH_SOURCES: 'nope' }), [])
  assert.deepEqual(huntSourcesFromEnv({ RESEARCH_SOURCES: 'linkedin-posts' }).map(s => s.id), ['linkedin-posts'])
})

test('repeat calls with one sourceState add only new work: no post query, derived search or Candidate twice', async () => {
  const log: string[] = []
  const sourceState = new Map<string, unknown>()
  const first = await hunt(CASE, PLAN, fakeSearch(log), { sources: [linkedinPostsSource()], sourceState, wait: async () => {}, concurrency: 1 })
  const n1 = log.length
  const second = await hunt(CASE, PLAN, fakeSearch(log), { sources: [linkedinPostsSource()], sourceState, wait: async () => {}, concurrency: 1 })
  const sent2 = log.slice(n1 + second.queries)
  const sent1 = log.slice(first.queries, n1)
  assert.ok(sent2.every(q => !sent1.includes(q)), 'no source query is sent twice')
  assert.equal(second.candidates.filter(c => c.via === 'engager').length, 0, 'the posts were returned by the first call')
  assert.ok(sourceState.get('linkedin-posts') && (sourceState.get('linkedin-posts') as ReturnType<typeof newDiscoveryState>).derived.size >= 2)
  // a NEW post that says the same thing (another handle, another day) yields the same derived search: it is not sent again
  const log3: string[] = []
  const same: SearchFn = async q => { log3.push(q); return q.startsWith('site:linkedin.com/posts') ? { ok: true, hits: [hit(liPost('uplift-sales-2', '2026-11-12'), "Uplift Sales's Post", 'Uplift Sales is a phone-only agency calling from Sydney, so these rules shape every campaign we set up.')] } : { ok: true, hits: [] } }
  const third = await hunt(CASE, { ...PLAN, triggers: [{ ...PLAN.triggers[0], queries: ['another trigger query Sydney'] }] }, same, { sources: [linkedinPostsSource()], sourceState, wait: async () => {}, concurrency: 1 })
  assert.equal(third.sources![0].in, 1); assert.equal(third.sources![0].dropped['same search'], 1)
  assert.ok(!log3.some(q => /^Uplift Sales/.test(q)), 'the same derived search is not sent twice')
})

test('a spend refusal inside the source stops it and is rethrown by the hunt; a stopped hunt runs no source', async () => {
  class Refused extends Error {}
  const log: string[] = []
  const refuse: SearchFn = async q => { log.push(q); if (q.startsWith('site:linkedin.com/posts')) throw new Refused('spend'); return { ok: true, hits: [] } }
  await assert.rejects(hunt(CASE, PLAN, refuse, { sources: [linkedinPostsSource()], wait: async () => {}, concurrency: 1 }), Refused)
  assert.equal(log.filter(q => q.startsWith('site:')).length, 1, 'nothing more is sent after the refusal')
  const log2: string[] = []
  const capped: SearchFn = async q => { log2.push(q); return { ok: false, reason: 'cap' } }
  const r = await hunt(CASE, PLAN, capped, { sources: [linkedinPostsSource()], wait: async () => {} })
  assert.equal(r.stopped, 'cap'); assert.equal(r.sources, undefined); assert.ok(!log2.some(q => q.startsWith('site:')))
  const log3: string[] = []
  const r3 = await hunt(CASE, PLAN, fakeSearch(log3), { sources: [linkedinPostsSource()], wait: async () => {}, deadline: 5, now: (() => { let t = 0; return () => (t += 3) })() })
  assert.ok(r3.stopped === 'deadline')
})
