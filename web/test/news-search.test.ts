import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { gdeltLang, newsUrl, parseGdelt, newsSearch, resetNewsQueue } from '../lib/search/news.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { Provider } from '../lib/llm/provider.ts'
import type { SafeGet } from '../lib/sources/types.ts'

// Free news search (GDELT DOC 2.0). The fixture follows a live response captured 2026-10-26 (fields and the tokenized
// title style); no network in tests.
const recent = new Date(Date.now() - 5 * 86_400_000)
const seen = recent.toISOString().slice(0, 10).replace(/-/g, '') + 'T061500Z'
const gdelt = (arts: { url: string; title: string }[]) => JSON.stringify({ articles: arts.map(a => ({ url: a.url, url_mobile: '', title: a.title, seendate: seen, socialimage: '', domain: new URL(a.url).hostname, language: 'English', sourcecountry: 'Canada' })) })

test('language filter from the ICP; unknown codes mean no filter; url carries query, artlist, json, recent first', () => {
  assert.equal(gdeltLang('pt'), 'portuguese'); assert.equal(gdeltLang('hi'), 'hindi'); assert.equal(gdeltLang('xx'), null); assert.equal(gdeltLang(undefined), null)
  const u = new URL(newsUrl('"escola de música" Lisboa', 'portuguese'))
  assert.equal(u.searchParams.get('query'), '"escola de música" Lisboa sourcelang:portuguese')
  assert.equal(u.searchParams.get('mode'), 'artlist'); assert.equal(u.searchParams.get('format'), 'json'); assert.equal(u.searchParams.get('sort'), 'datedesc')
  assert.equal(new URL(newsUrl('x', null)).searchParams.get('query'), 'x')
})

test('articles become dated hits with the publisher url; tokenized titles are tidied; bad rows and bad JSON dropped', () => {
  const hits = parseGdelt(gdelt([{ url: 'https://news.example.com/acme', title: 'Acme Dental raises $1 . 5 million , opens ( second ) clinic' }, { url: 'http://insecure.example.com/x', title: 'x' }]))
  assert.deepEqual(hits, [{ url: 'https://news.example.com/acme', title: 'Acme Dental raises $1. 5 million, opens (second) clinic', snippet: '', date: recent.toISOString().slice(0, 10) }])
  assert.deepEqual(parseGdelt('Please limit requests to one every 5 seconds'), [])
  assert.deepEqual(parseGdelt('{}'), [])
})

test('requests are spaced by the shared queue (GDELT: one per 5 s), deduped, and failures only mean fewer hits', async () => {
  resetNewsQueue()
  const waits: number[] = []
  const body = gdelt([{ url: 'https://news.example.com/acme', title: 'Acme Dental opens second clinic' }])
  const http: SafeGet = async url => (url.includes('fail') ? { status: 429, body: 'Please limit requests' } : { status: 200, body })
  const hits = await newsSearch(http, ['a', 'fail', 'b'], 'en', { gapMs: 5100, sleep: async ms => { waits.push(ms) } })
  assert.equal(hits.length, 1)
  assert.equal(waits.length, 2) // the 2nd and 3rd requests waited; the 1st did not
  assert.ok(waits.every(w => w > 0 && w <= 5100))
})

test('TinyFish off: a scan finds and verifies a lead from news, quoting the fetched article, with no paid research call', async () => {
  resetNewsQueue()
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Dental clinics in Toronto expanding', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['Toronto'], signals: ['opening a new location'], exclude: [], country: 'CA', language: 'en' }
  const id = createQueryJob(db, 'A', { query: 'Dental clinics in Toronto opening a new location', icp: JSON.stringify(icp) } as never)
  const QUOTE = 'Acme Dental said it will open a second clinic in Toronto next month'
  const requested: string[] = []
  const http: SafeGet = async url => { requested.push(url); return { status: 200, body: gdelt([{ url: 'https://news.example.com/acme', title: 'Acme Dental opens second Toronto clinic' }]) } }
  let research = 0; let extractionPrompt = ''
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => { research++; return { text: '[]', citedUrls: [] } },
      complete: async (_k, p) => {
        if (p.startsWith('Write up to')) return '["dental clinic second location Toronto"]'
        extractionPrompt = p
        return JSON.stringify([{ name: '', company: 'Acme Dental', contact: null, signal: 'Opening a second Toronto clinic', source_url: 'https://news.example.com/acme', excerpt: QUOTE, event_date: recent.toISOString().slice(0, 10), score: 80 }])
      },
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const article = `Toronto business news. ${QUOTE}. The clinic will add six chairs and hire two hygienists. More text about the expansion plans follows here so the page is long enough to be read.`
  const page = async () => ({ text: article, title: 'Acme Dental opens second Toronto clinic', retrievedAt: 1 })
  assert.equal(await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, fetchPage: page, newsHttp: http, judge: null, score: false }), 'done')
  const leads = listLeads(db, 'A', id) as { company: string; review_reason: string | null }[]
  assert.deepEqual(leads.map(l => [l.company, l.review_reason]), [['Acme Dental', null]])
  assert.equal(research, 0)
  assert.ok(extractionPrompt.includes('will add six chairs'), 'the model read the fetched article text, not only the headline')
  assert.ok(requested.every(u => new URL(u).searchParams.get('query')!.endsWith(' sourcelang:english')))
})
