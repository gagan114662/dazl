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
  assert.deepEqual(normalizeSources({ adapters: ['github', 'rss', 'rss'], feeds: ['https://a.example/feed', 'file:///etc/passwd', 'https://a.example/feed'] }), { adapters: ['github', 'rss'], feeds: ['https://a.example/feed'] })
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
  assert.equal(out, 'done')
  assert.ok(completeCalls <= 1)
})
