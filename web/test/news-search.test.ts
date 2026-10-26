import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { bingMarket, newsUrl, publisherUrl, parseNewsRss, newsSearch } from '../lib/search/news.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { Provider } from '../lib/llm/provider.ts'
import type { SafeGet } from '../lib/sources/types.ts'

// Free news search (Bing News RSS) beside TinyFish. Fixture feeds only; no network.
const recent = new Date(Date.now() - 5 * 86_400_000)
const feed = (items: { url: string; title: string; desc: string }[]) => `<?xml version="1.0"?><rss><channel>${items.map(i => `<item><title>${i.title}</title><link>https://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=x&amp;url=${encodeURIComponent(i.url)}&amp;c=1</link><description>${i.desc}</description><pubDate>${recent.toUTCString()}</pubDate></item>`).join('')}</channel></rss>`

test('market from the ICP; query url carries it; no market when either part is unknown', () => {
  assert.equal(bingMarket('PT', 'pt'), 'pt-PT'); assert.equal(bingMarket('IN', 'hi'), 'hi-IN'); assert.equal(bingMarket(undefined, 'en'), null)
  const u = new URL(newsUrl('escola de música Lisboa', 'pt-PT'))
  assert.equal(u.searchParams.get('format'), 'rss'); assert.equal(u.searchParams.get('mkt'), 'pt-PT'); assert.equal(u.searchParams.get('q'), 'escola de música Lisboa')
})

test('the publisher url is taken from the Bing click-through; bing-only or non-https links are dropped', () => {
  assert.equal(publisherUrl('https://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fnews.example.com%2facme-opens&amp;c=1'), 'https://news.example.com/acme-opens')
  assert.equal(publisherUrl('https://www.bing.com/news/apiclick.aspx?c=1'), null)
  assert.equal(publisherUrl('https://www.bing.com/news/apiclick.aspx?url=http%3a%2f%2fplain.example.com%2fx'), null)
  assert.equal(publisherUrl('https://direct.example.org/story'), 'https://direct.example.org/story')
})

test('feed items become dated hits with title and description', () => {
  const hits = parseNewsRss(feed([{ url: 'https://news.example.com/acme', title: 'Acme Dental opens second Toronto clinic', desc: 'Acme Dental said it will open a second clinic in Toronto next month.' }]))
  assert.deepEqual(hits, [{ url: 'https://news.example.com/acme', title: 'Acme Dental opens second Toronto clinic', snippet: 'Acme Dental said it will open a second clinic in Toronto next month.', date: recent.toISOString().slice(0, 10) }])
})

test('newsSearch dedupes across queries and survives failed requests', async () => {
  const body = feed([{ url: 'https://news.example.com/acme', title: 'Acme Dental opens second clinic', desc: 'x' }])
  const http: SafeGet = async url => (url.includes('fail') ? null : { status: 200, body })
  assert.equal((await newsSearch(http, ['a', 'fail', 'b'], null)).length, 1)
})

test('TinyFish off: a scan finds and verifies a lead from the free news search before any paid web search', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Dental clinics in Toronto expanding', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['Toronto'], signals: ['opening a new location'], exclude: [], country: 'CA', language: 'en' }
  const id = createQueryJob(db, 'A', { query: 'Dental clinics in Toronto opening a new location', icp: JSON.stringify(icp) } as never)
  const QUOTE = 'Acme Dental said it will open a second clinic in Toronto next month'
  const requested: string[] = []
  const http: SafeGet = async url => { requested.push(url); return { status: 200, body: feed([{ url: 'https://news.example.com/acme', title: 'Acme Dental opens second Toronto clinic', desc: QUOTE + '.' }]) } }
  let research = 0
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => { research++; return { text: '[]', citedUrls: [] } },
      complete: async (_k, p) => p.startsWith('Write up to') ? '["dental clinic second location Toronto"]'
        : JSON.stringify([{ name: '', company: 'Acme Dental', contact: null, signal: 'Opening a second Toronto clinic', source_url: 'https://news.example.com/acme', excerpt: QUOTE, event_date: recent.toISOString().slice(0, 10), score: 80 }]),
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async () => ({ text: `Toronto news. ${QUOTE}. More text about the clinic.`, title: 'Acme Dental opens second Toronto clinic', retrievedAt: 1 })
  assert.equal(await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, fetchPage: page, newsHttp: http, judge: null, score: false }), 'done')
  const leads = listLeads(db, 'A', id) as { company: string; review_reason: string | null }[]
  assert.deepEqual(leads.map(l => [l.company, l.review_reason]), [['Acme Dental', null]])
  assert.equal(research, 0) // the paid provider web search was not needed
  assert.ok(requested.every(u => new URL(u).searchParams.get('mkt') === 'en-CA'))
})
