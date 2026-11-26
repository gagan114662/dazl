// #1910: the contact step must run for a discovery-lane job too. Ziggy's diagnosis on the issue: every prod job since
// 2026-11-23 ~13:55Z had enrich_started_at NULL and the last crawl_pages row is 13:53Z that day, so proof-carrying leads
// showed "no contact found yet" and Ready stayed 0. The older lane runs beginEnrichment -> runPostFinishBounded ->
// endEnrichment after the job is done (runner.ts:1097); the discovery lane returned straight after finish().
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { DiscoverResult, DiscoveredLead } from '../lib/discover/agent.ts'
import type { Get } from '../lib/connectors/sitecrawl.ts'

const lead = (o: Partial<DiscoveredLead>): DiscoveredLead => ({ company: 'Northwind Dental', domain: 'northwind-dental.example', signal: 'Opening a second clinic', signal_date: '2026-10-14', evidence_url: 'https://news.example/northwind', evidence_quote: 'Northwind Dental will open its second clinic', person: 'Dana Ruiz', title: 'Practice Owner', person_source_url: 'https://northwind-dental.example/team', linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'expanding', ...o })

test('#1910 a discovery-lane job runs the contact step: enrich_started_at is recorded and the company site is read', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  process.env.SITECRAWL_ENABLED = '1'
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const canned: DiscoverResult = {
    leads: [lead({})],
    seen: [{ url: 'https://news.example/northwind', title: 'Northwind Dental', page_age: null, text: 'On 14 October 2026 Northwind Dental will open its second clinic downtown.' }],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 }, stop: 'end_turn', model: 'm', note: null,
  }
  const read: string[] = []
  const get = (async (input: string | URL | Request) => {
    const url = String(input)
    read.push(url)
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } })
    if (url.includes('northwind-dental.example')) return new Response('<html><body><p>Contact our practice manager <a href="mailto:office@northwind-dental.example">office@northwind-dental.example</a></p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    if (url.includes('news.example/northwind')) return new Response('<html><body><p>Northwind Dental will open its second clinic.</p><p><a href="https://northwind-dental.example/team">Our team</a></p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    return new Response('no', { status: 403 })
  }) as unknown as typeof fetch
  // the crawl's own Get: the same pages, in the shape lib/connectors/sitecrawl.ts takes (status, body, finalUrl)
  const crawlGet = (async (url: string) => {
    const res = await get(url)
    return { status: res.status, body: await res.text(), finalUrl: url }
  }) as unknown as Get
  const result = await runJob(db, job!, { master, fetchImpl: get, crawlGet, discover: true, enrichImpl: null,
    discoverImpl: async () => canned })
  assert.equal(result, 'done')
  const j = db.prepare('SELECT status, enrich_started_at, enrich_finished_at FROM scan_jobs WHERE id = ?').get(id) as { status: string; enrich_started_at: number | null; enrich_finished_at: number | null }
  assert.equal(j.status, 'done')
  assert.ok(j.enrich_started_at, 'the contact step ran: enrich_started_at is recorded (NULL on every prod job since 2026-11-23)')
  assert.ok(j.enrich_finished_at, 'and it recorded its end, so the page never waits as "enriching"')
  assert.ok(read.some(u => u.includes('news.example/northwind')), `the contact step read the page this lead is built on: ${read.join(', ')}`)
})
