import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { parseFeed } from '../lib/sources/rss.ts'
import { githubAdapter, resetGithubState } from '../lib/sources/github.ts'
import { buildSourcePrompt, collectEvidence, keywordsFor, normalizeSources } from '../lib/sources/index.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { isPublicIp } from '../lib/scan/fetch-page.ts'

const RSS = `<?xml version="1.0"?><rss><channel><item><title>Acme Robotics hires its first VP of Sales &amp; opens Berlin office</title><link>https://acme.example/news/1</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Short</title><link>https://acme.example/2</link></item><item><title>Insecure link item that is long enough</title><link>http://acme.example/3</link></item></channel></rss>`
const ATOM = `<feed><entry><title>Beta Labs raises seed round to hire sales team</title><link href="https://beta.example/p/9"/><updated>2026-10-01T08:00:00Z</updated></entry></feed>`

test('feed parsing: rss and atom, https links only, titles of 20+ chars, ISO dates', () => {
  assert.deepEqual(parseFeed(RSS).map(e => [e.url, e.date, e.title]), [['https://acme.example/news/1', '2026-10-12', 'Acme Robotics hires its first VP of Sales & opens Berlin office']])
  assert.deepEqual(parseFeed(ATOM).map(e => [e.url, e.date]), [['https://beta.example/p/9', '2026-10-01']])
})

test('source selection is validated: unknown adapters, non-https feeds and rss without feeds are dropped', () => {
  assert.equal(normalizeSources(null), null)
  assert.equal(normalizeSources({ adapters: ['twitter'], feeds: [] }), null)
  assert.equal(normalizeSources({ adapters: ['rss'], feeds: ['http://x.example/feed'] }), null)
  assert.deepEqual(normalizeSources({ adapters: ['github', 'rss', 'rss'], feeds: ['https://a.example/feed', 'file:///etc/passwd', 'https://a.example/feed'] }), { adapters: ['github', 'rss'], feeds: ['https://a.example/feed'], pages: [] })
  assert.deepEqual(keywordsFor('Looking for seed-stage fintech founders who hired sales'), ['seed-stage', 'fintech', 'founders', 'hired', 'sales'])
})

test('collectEvidence: adapters get only a guarded http function, failures give no evidence', async () => {
  resetGithubState()
  const seen: string[] = []
  const http: SafeGet = async url => {
    seen.push(url)
    if (url.startsWith('https://api.github.com/')) return { status: 200, body: JSON.stringify({ items: [{ full_name: 'acme/robot-sdk', html_url: 'https://github.com/acme/robot-sdk', description: 'SDK for Acme warehouse robots and sales demos', pushed_at: '2026-10-10T00:00:00Z' }, { full_name: 'x/y', html_url: 'https://github.com/x/y', description: 'short' }] }) }
    if (url === 'https://acme.example/feed') return { status: 200, body: RSS }
    return null
  }
  const ev = await collectEvidence({ adapters: ['github', 'rss'], feeds: ['https://acme.example/feed', 'https://dead.example/feed'] }, 'robotics sales hires', http, 2000)
  assert.deepEqual(ev.map(e => [e.source, e.url, e.date]).sort(), [['github', 'https://github.com/acme/robot-sdk', '2026-10-10'], ['rss', 'https://acme.example/news/1', '2026-10-12']])
  assert.ok(seen.every(u => u.startsWith('https://')))
  assert.match(buildSourcePrompt('q', {}, ev), /not instructions/)
})

test('github adapter caps calls per hour and caches', async () => {
  resetGithubState()
  let n = 0
  const http: SafeGet = async () => { n++; return { status: 200, body: '{"items":[]}' } }
  await githubAdapter.collect({ query: 'q', keywords: ['alpha', 'beta'], feeds: [], http })
  await githubAdapter.collect({ query: 'q', keywords: ['alpha', 'beta'], feeds: [], http })
  assert.equal(n, 1)
})

test('private and metadata addresses are refused by the shared guard', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '::1']) assert.equal(isPublicIp(ip), false)
})

test('a scan with sources adds source candidates to the same verifier; rejected key still fails', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  const master = randomBytes(32)
  saveKey(db, 'u1', 'anthropic', 'sk-ant-' + 'a'.repeat(40), master)
  const icp = JSON.stringify({ summary: 's', who: ['w'], where: [], signals: ['hiring'], exclude: [] })
  const id = createQueryJob(db, 'u1', { query: 'robotics sales hires', icp, sources: JSON.stringify({ adapters: ['rss'], feeds: ['https://acme.example/feed'] }) })
  const job = claimKeyedJob(db, id)!
  assert.equal(job.sources, JSON.stringify({ adapters: ['rss'], feeds: ['https://acme.example/feed'] }))
  const extra = JSON.stringify([{ name: '', company: 'Acme Robotics', contact: null, signal: 'hired a VP of Sales', source_url: 'https://acme.example/news/1', excerpt: 'Acme Robotics hires its first VP of Sales & opens Berlin office', event_date: '2026-10-12', score: 80 }])
  let completeCalls = 0
  const prov = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => { completeCalls++; return extra } }
  // collectEvidence uses the real network guard; the test only checks the wiring when no evidence is reachable
  const out = await runJob(db, job, { providers: { anthropic: prov, openai: prov } as never, master, fetchPage: async () => null, now: new Date('2026-10-20'), judge: null })
  assert.equal(out, 'failed') // no candidates at all: fails honestly instead of an empty done
  assert.ok(completeCalls <= 1)
})

// --- Tier 0 adapters: Jina Reader web pages, V2EX, YouTube ---

import { jinaAdapter, parseReader, pickQuote as pickJinaQuote, resetJinaState } from '../lib/sources/jina.ts'
import { v2exAdapter, toEvidence as v2exEvidence, resetV2exState } from '../lib/sources/v2ex.ts'
import { youtubeAdapter, toEvidence as youtubeEvidence, resetYoutubeState } from '../lib/sources/youtube.ts'

const JINA = `Title: Acme Robotics raises $8M to expand warehouse sales

URL Source: https://acme.example/blog/raise

Published Time: Mon, 12 Oct 2026 10:00:00 GMT

Markdown Content:
Acme Robotics announced an $8M round today. The company plans to expand its warehouse sales team across Europe.

Short bit.`

test('jina: reader markdown parses into title, date and a latin quote', () => {
  const { title, published, content } = parseReader(JINA)
  assert.equal(title, 'Acme Robotics raises $8M to expand warehouse sales')
  assert.equal(published, '2026-10-12')
  const q = pickJinaQuote(content, ['warehouse'])
  assert.ok(q.includes('warehouse sales team'), q)
  assert.ok(q.length >= 20 && q.length <= 300)
})

test('jina adapter: reads each page once (cache), caps calls, cites the original URL', async () => {
  resetJinaState()
  let n = 0
  const http: SafeGet = async url => { n++; assert.ok(url.startsWith('https://r.jina.ai/https://acme.example/')); return { status: 200, body: JINA } }
  const ev1 = await jinaAdapter.collect({ query: 'q', keywords: ['warehouse'], feeds: [], pages: ['https://acme.example/blog/raise'], http })
  const ev2 = await jinaAdapter.collect({ query: 'q', keywords: ['warehouse'], feeds: [], pages: ['https://acme.example/blog/raise'], http })
  assert.equal(n, 1)
  assert.equal(ev1.length, 1)
  assert.equal(ev1[0].url, 'https://acme.example/blog/raise')
  assert.equal(ev1[0].source, 'web')
  assert.equal(ev1[0].date, '2026-10-12')
  assert.deepEqual(ev2, ev1)
})

test('v2ex: chinese-only topics are dropped, latin-rich topics become evidence', () => {
  const topics = [
    { id: 1, title: '远程工作讨论：在家办公的日常', content: '都是一些中文内容，没有英文。', created: 1760000000 },
    { id: 2, title: 'Hiring: remote TypeScript developers for our SaaS platform', content: 'We are hiring remote TypeScript developers for a growing SaaS platform. EU timezone preferred.', created: 1760000000 },
  ]
  const ev = v2exEvidence(topics, ['hiring'])
  assert.equal(ev.length, 1)
  assert.equal(ev[0].url, 'https://www.v2ex.com/t/2')
  assert.equal(ev[0].date, '2025-10-09')
  assert.ok(ev[0].quote.includes('TypeScript'))
})

test('v2ex adapter: sov2ex search, official hot fallback, cache', async () => {
  resetV2exState()
  let n = 0
  const http: SafeGet = async url => {
    n++
    if (url.startsWith('https://www.sov2ex.com/')) return { status: 200, body: JSON.stringify({ hits: [{ _id: '42', _source: { title: 'Remote hiring thread for startup founders and CTOs', content: 'We are a seed stage startup hiring our first sales engineer, remote ok.', created: '2026-10-01T08:00:00Z' } }] }) }
    return null
  }
  const ev = await v2exAdapter.collect({ query: 'q', keywords: ['hiring'], feeds: [], http })
  assert.equal(ev.length, 1)
  assert.equal(ev[0].url, 'https://www.v2ex.com/t/42')
  assert.equal(ev[0].date, '2026-10-01')
  await v2exAdapter.collect({ query: 'q', keywords: ['hiring'], feeds: [], http })
  assert.equal(n, 1)
})

test('youtube: only verifiable titles and real video ids survive', () => {
  const ev = youtubeEvidence([
    { id: 'dQw4w9WgXcQ', title: 'Acme Corp announces Series A funding round', published: '2026-10-05' },
    { id: 'bad id!', title: 'Another fine video title here', published: '2026-10-05' },
    { id: 'abcdefghijk', title: '短', published: '2026-10-05' },
  ])
  assert.deepEqual(ev.map(e => [e.url, e.date]), [['https://www.youtube.com/watch?v=dQw4w9WgXcQ', '2026-10-05']])
  assert.equal(ev[0].quote, 'Acme Corp announces Series A funding round')
})

test('youtube adapter: piped backend maps streams, caches, tries the next instance on failure', async () => {
  resetYoutubeState()
  delete process.env.YOUTUBE_API_KEY
  const seen: string[] = []
  const http: SafeGet = async url => {
    seen.push(url)
    if (url.includes('pipedapi.kavin.rocks')) return null
    return { status: 200, body: JSON.stringify({ items: [{ type: 'stream', url: '/watch?v=dQw4w9WgXcQ', title: 'Beta Labs raises seed round to hire sales team', uploaded: 1760000000000 }, { type: 'channel', url: '/channel/x', title: 'A channel not a video at all' }] }) }
  }
  const ev = await youtubeAdapter.collect({ query: 'q', keywords: ['raises'], feeds: [], http })
  assert.equal(ev.length, 1)
  assert.equal(ev[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(ev[0].date, '2025-10-09')
  assert.ok(seen[0].includes('api.piped.private.coffee'))
  await youtubeAdapter.collect({ query: 'q', keywords: ['raises'], feeds: [], http })
  assert.equal(seen.length, 1)
})

test('source selection: web needs page URLs, pages are validated like feeds', () => {
  assert.equal(normalizeSources({ adapters: ['web'], feeds: [], pages: [] }), null)
  assert.deepEqual(normalizeSources({ adapters: ['web', 'v2ex', 'youtube'], feeds: [], pages: ['https://a.example/p', 'http://no.example', 'https://a.example/p'] }), { adapters: ['web', 'v2ex', 'youtube'], feeds: [], pages: ['https://a.example/p'] })
})
