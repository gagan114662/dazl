// What the semantic judge was given and answered is kept in the run report for every judged candidate, so a rejection ("contradicted") can be
// examined (correct rejection or false negative) instead of guessed. Diagnostic only: the verdict still decides exactly as before and nothing is
// reversed. Invented pages and a stubbed judge; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'

const REQUEST = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days AND are currently hiring sales staff.'
const ICP = { summary: 's', who: ['Founder'], industries: ['B2B SaaS'], sizes: ['10-50 employees'], where: ['London, UK'], signals: ['announced seed funding within the past 90 days AND currently hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const U1 = 'https://blog.example/orchestra-raises-3-3m', U2 = 'https://news.example/brightloop-seed'
const Q1 = 'Orchestra, headquartered in London, announced a $3.3M seed round and is expanding its engineering and go-to-market teams'
const Q2 = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round and is hiring two account executives'
const pad = (s: string) => `${s} ${'More page text about the company. '.repeat(15)}`
const page = (t: string) => ({ title: 'News', text: pad(`Published ${daysAgo(10)}. ${t}.`) })
const cand = (company: string, url: string, excerpt: string, signal: string): Cand => ({ company, signal, source_url: url, excerpt, event_date: daysAgo(10) })
const fx = (): Fixture => ({
  request: REQUEST, modelIcp: ICP, modelQueries: ['q'], hits: [{ url: U1, title: 'a', snippet: Q1, date: daysAgo(10) }, { url: U2, title: 'b', snippet: Q2, date: daysAgo(10) }],
  tfPages: { [U1]: page(Q1), [U2]: page(Q2) }, own: { [U1]: page(Q1), [U2]: page(Q2) },
  extraction: [cand('Orchestra', U1, Q1, 'raised a $3.3M seed round and has an open sales vacancy'), cand('Brightloop', U2, Q2, 'raised a seed round and is hiring account executives')],
  deps: { judge: async (c: { company: string }) => (c.company === 'Orchestra' ? 'contradicts' : 'supports') },
})

test('the run report keeps, per judged candidate, the exact extracted claim, the passage shown to the judge and its verdict; the verdict still decides as before', async () => {
  const r = await runFixture(fx())
  const cands = r.report!.candidates as { company: string; fate: string; judge?: { verdict: string; claim: string; passage: string } }[]
  const o = cands.find(c => c.company === 'Orchestra')!, b = cands.find(c => c.company === 'Brightloop')!
  assert.equal(o.fate, 'dropped:contradicted', 'not reversed'); assert.equal(b.fate, 'verified')
  assert.deepEqual([o.judge!.verdict, o.judge!.claim], ['contradicts', 'raised a $3.3M seed round and has an open sales vacancy'], 'the exact claim the model extracted (it asserts more than the quote shows)')
  assert.ok(o.judge!.passage.includes('headquartered in london announced a 3.3m seed round') && o.judge!.passage.length <= 600, 'the passage the judge was shown (the verifier\u2019s normalised text: lower-case, punctuation removed)')
  assert.deepEqual([b.judge!.verdict, b.judge!.claim], ['supports', 'raised a seed round and is hiring account executives'])
  assert.deepEqual(r.leads.filter(l => !l.review_reason).map(l => l.company), ['Brightloop'])
})

test('no judge available -> no judge detail (nothing is invented)', async () => {
  const f = fx(); f.deps = {}
  const r = await runFixture(f)
  for (const c of r.report!.candidates as { judge?: unknown }[]) assert.equal(c.judge, undefined)
})
