import test from 'node:test'
import assert from 'node:assert/strict'
import { extractRaise, matchesCompany, fundingNews, fundingRoundFor } from '../lib/signals/funding-round.ts'

test('extractRaise parses company, amount and stage from a headline', () => {
  assert.deepEqual(extractRaise('Acme Robotics raises $30M Series B to expand'), { company: 'Acme Robotics', amount: '$30M', stage: 'Series B' })
  assert.deepEqual(extractRaise('Exclusive: Jack & Jill lands $12 million seed round'), { company: 'Jack & Jill', amount: '$12M', stage: 'Seed' })
  assert.equal(extractRaise('The best CRM tools for 2026'), null)
  assert.equal(extractRaise('Markets fall as rates rise'), null)
})

test('matchesCompany uses token overlap with suffix stripping', () => {
  assert.equal(matchesCompany('Acme Robotics Inc', 'Acme Robotics'), true)
  assert.equal(matchesCompany('Acme Robotics', 'Acme Robotics raises $30M Series B'), true)
  assert.equal(matchesCompany('Globex', 'Acme Robotics'), false)
})

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Acme Robotics raises $30M Series B to expand</title><link>https://news.example/acme</link><pubDate>${new Date(Date.now() - 5 * 86400_000).toUTCString()}</pubDate></item>
<item><title>Old Corp raises $9M Seed</title><link>https://news.example/old</link><pubDate>${new Date(Date.now() - 120 * 86400_000).toUTCString()}</pubDate></item>
<item><title>Random gadget review</title><link>https://news.example/gadget</link><pubDate>${new Date().toUTCString()}</pubDate></item>
</channel></rss>`

test('fundingNews keeps only raise headlines inside the 60-day window', async () => {
  const fetchImpl = async () => new Response(FEED, { status: 200 })
  const news = await fundingNews(fetchImpl as typeof fetch, ['https://feed.example/rss'])
  assert.equal(news.length, 1)
  assert.equal(news[0].company, 'Acme Robotics')
  assert.equal(news[0].amount, '$30M')
})

test('fundingRoundFor matches a lead and reports days ago without Jina when fields are complete', async () => {
  const news = [{ url: 'https://news.example/acme', title: 'Acme Robotics raises $30M Series B', date: '2026-10-16', company: 'Acme Robotics', amount: '$30M', stage: 'Series B' }]
  let jinaCalls = 0
  const r = await fundingRoundFor('Acme Robotics Inc', news, { now: new Date('2026-10-21T00:00:00Z'), jina: async () => { jinaCalls++; return '' } })
  assert.ok(r)
  assert.equal(r!.daysAgo, 5)
  assert.equal(jinaCalls, 0)
  assert.equal(await fundingRoundFor('Globex', news), null)
})

test('fundingRoundFor uses Jina only for public https article URLs and survives its failure', async () => {
  const news = [{ url: 'https://news.example/acme', title: 'Acme Robotics closes new funding', date: new Date().toISOString().slice(0, 10), company: 'Acme Robotics', amount: null, stage: null }]
  const r = await fundingRoundFor('Acme Robotics', news, { jina: async () => { throw new Error('429') } })
  assert.ok(r) // feed-only fields stand
  assert.equal(r!.amount, null)
  const internal = [{ ...news[0], url: 'http://169.254.169.254/latest/meta-data' }]
  let calls = 0
  const r2 = await fundingRoundFor('Acme Robotics', internal, { jina: async () => { calls++; return '' } })
  assert.ok(r2)
  assert.equal(calls, 0) // never sends a non-public URL to the third-party reader
})
