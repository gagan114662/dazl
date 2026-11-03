import { gdeltAttribution } from '../lib/search/news-attribution.ts'
import { toEvidence } from '../lib/search/tinyfish.ts'
import { exportLeads } from '../lib/scan/store.ts'
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

test('articles become hits with the publisher url and GDELT\'s observed date kept apart from the event date; tokenized titles are tidied; bad rows and bad JSON dropped', () => {
  const hits = parseGdelt(gdelt([{ url: 'https://news.example.com/acme', title: 'Acme Dental raises $1 . 5 million , opens ( second ) clinic' }, { url: 'http://insecure.example.com/x', title: 'x' }]))
  assert.deepEqual(hits, [{ url: 'https://news.example.com/acme', title: 'Acme Dental raises $1. 5 million, opens (second) clinic', snippet: '', date: null, observed: recent.toISOString().slice(0, 10), via: 'gdelt' }])
  assert.deepEqual(parseGdelt('Please limit requests to one every 5 seconds'), [])
  assert.deepEqual(parseGdelt('{}'), [])
})

test('requests are spaced by the shared queue (GDELT: one per 5 s), deduped, and failures only mean fewer hits', async () => {
  resetNewsQueue()
  const waits: number[] = []
  const body = gdelt([{ url: 'https://news.example.com/acme', title: 'Acme Dental opens second clinic' }])
  const http: SafeGet = async url => (url.includes('fail') ? { status: 429, body: 'Please limit requests' } : { status: 200, body })
  const r = await newsSearch(http, ['a', 'fail', 'b'], 'en', { gapMs: 5100, sleep: async ms => { waits.push(ms) } })
  assert.equal(r.hits.length, 1); assert.deepEqual([r.attempted, r.failed], [3, 1], 'request failures are reported apart from the hits')
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
  // Instinct #195: GDELT's seendate is when it OBSERVED the article, never an asserted event date in the extraction input.
  const items = JSON.parse(extractionPrompt.slice(extractionPrompt.indexOf('Items (index, source, url, title, text, date): ') + 'Items (index, source, url, title, text, date): '.length).split('\n')[0])
  assert.equal(items.length, 1); assert.equal(items[0].source, 'news:gdelt'); assert.equal(items[0].date, null)
  assert.ok(!JSON.stringify(items).includes(recent.toISOString().slice(0, 10)), 'the observed date is not in the items the model sees')
  // Attribution is persisted per lead (lead_sources) and shown with the link GDELT's terms require; tenant-scoped.
  const leadId = (leads as unknown as { id: string }[])[0].id
  const via = gdeltAttribution(db, 'A', [leadId])
  assert.deepEqual(via.get(leadId), { text: 'Found through the GDELT Project', link: 'https://www.gdeltproject.org/' })
  assert.equal(gdeltAttribution(db, 'B', [leadId]).size, 0)
  assert.equal(((exportLeads(db, 'A') as { lead_id: string }[])[0]).lead_id, leadId)
})

test('TinyFish-supplement path: a GDELT hit becomes news:gdelt evidence with date null and the observed date as context only; a TinyFish hit is unchanged', () => {
  const hits = [
    { url: 'https://news.example.com/a', title: 'A', snippet: '', date: null, observed: '2026-10-20', via: 'gdelt' as const },
    { url: 'https://t.example.com/b', title: 'B', snippet: 'a long enough snippet for the evidence text here', date: '2026-10-01' },
  ]
  const pages = [{ url: 'https://news.example.com/a', title: 'A', text: 'Acme Dental opens a second clinic in Toronto next month, the company said.' }]
  const ev = toEvidence(hits, pages)
  assert.deepEqual(ev.map(e => [e.source, e.date, e.updated ?? null]), [['news:gdelt', null, '2026-10-20'], ['tinyfish', '2026-10-01', null]])
})

// TinyFish-supplement path: only the lead whose page GDELT surfaced is credited to news:gdelt (attribution is per lead).
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
test('supplement path: the GDELT-surfaced lead carries the attribution, the TinyFish-surfaced lead does not', async () => {
  resetNewsQueue()
  const master = randomBytes(32); process.env.DAZL_MASTER_KEY = master.toString('base64')
  process.env.TINYFISH_API_KEY = 'tf-test-key'
  const day = recent.toISOString().slice(0, 10)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Dental clinics in Toronto expanding', who: ['Practice owner'], industries: [], sizes: [], where: ['Toronto'], signals: [], exclude: [], country: 'CA', language: 'en' }
  const id = createQueryJob(db, 'A', { query: 'Dental clinics in Toronto opening a new location', icp: JSON.stringify(icp) } as never)
  const QA = 'Alpha Dental announced it will open a second clinic in Toronto next month'; const QB = 'Beta Dental said it is opening a new Toronto location this spring'
  const tfFetch = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://tf.example.com/alpha', title: 'Alpha', snippet: QA, date: day }] }), { status: 200 })
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://tf.example.com/alpha', title: 'Alpha', text: `${QA}. More text so this page is long enough to be a real article body.` }, { url: 'https://news.example.com/beta', title: 'Beta', text: `${QB}. More text so this page is long enough to be a real article body.` }] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const http: SafeGet = async () => ({ status: 200, body: gdelt([{ url: 'https://news.example.com/beta', title: 'Beta Dental opens' }]) })
  const lead = (company: string, url: string, excerpt: string) => ({ name: '', company, contact: null, signal: 'Opening a Toronto clinic', source_url: url, excerpt, event_date: day, score: 80 })
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k, p) => p.startsWith('Write up to') ? '["dental clinic second location Toronto"]' : JSON.stringify([lead('Alpha Dental', 'https://tf.example.com/alpha', QA), lead('Beta Dental', 'https://news.example.com/beta', QB)]) },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async (u: string) => ({ text: u.includes('beta') ? `${QB}. More text so this page is long enough to be a real article body.` : `${QA}. More text so this page is long enough to be a real article body.`, title: 't', retrievedAt: 1 })
  const realFetch = globalThis.fetch; globalThis.fetch = tfFetch
  try { await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, fetchPage: page, fetchImpl: tfFetch, newsHttp: http, judge: null, score: false }) } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
  const leads = listLeads(db, 'A', id) as { id: string; company: string }[]
  const via = gdeltAttribution(db, 'A', leads.map(l => l.id))
  assert.deepEqual(leads.map(l => [l.company, via.has(l.id)]).sort(), [['Alpha Dental', false], ['Beta Dental', true]])
})

test('a GDELT rate-limit answer is counted apart from failures, stops this scan\'s queries, and widens later spacing', async () => {
  resetNewsQueue()
  const waits: number[] = []
  let calls = 0
  const http: SafeGet = async () => { calls++; return { status: 200, body: 'Please limit requests to one every 5 seconds' } }
  const r = await newsSearch(http, ['a', 'b', 'c'], 'en', { gapMs: 5100, sleep: async ms => { waits.push(ms) } })
  assert.deepEqual([r.attempted, r.failed, r.limited, calls], [1, 0, 1, 1], 'first answer is a limit: stop asking rather than hammering a throttling provider')
  const r2 = await newsSearch(http, ['d'], 'en', { gapMs: 5100, sleep: async ms => { waits.push(ms) } })
  assert.equal(r2.limited, 1)
  assert.ok(waits.some(w => w > 30000), `after a limit the shared spacing widens beyond the 5 s floor, got waits ${waits}`)
  resetNewsQueue()
})

test('newsStatus names a rate-limited source honestly: limited, never error or empty', async () => {
  const { newsStatus } = await import('../lib/scan/runner.ts')
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 3, failed: 0, limited: 1 }), 'limited')
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 3, failed: 2, limited: 1 }), 'limited_partial:2_of_3')
  assert.equal(newsStatus(null, { searched: true, hits: 2, attempted: 3, failed: 0, limited: 1 }), 'partial:limited_1_of_3')
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 3, failed: 3 }), 'error', 'a plain outage still says error')
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 3, failed: 0 }), 'empty', 'a real zero-result search still says empty')
})
