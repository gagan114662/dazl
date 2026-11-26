import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { addEnrichment, enrichmentsForLeads, type Enrichment } from '../lib/connectors/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob } from '../lib/scan/store.ts'

const tenant = 'fixture'
const domain = 'ferndental.example'
const home = `https://${domain}/`
const team = `${home}team`
const evidence = `${home}careers`
const company = 'Fern Dental'
const quote = 'Fern Dental is hiring a dental receptionist in Austin'
const now = Date.parse('2026-11-26T12:00:00Z')
const buyer = { kind: 'person', value: 'Dana Ruiz, Practice Manager', source_url: team } as const
const email = { kind: 'email', value: `dana.ruiz@${domain}`, source_url: team } as const
type CrawlRow = Pick<Enrichment, 'kind' | 'value' | 'source_url'>

const found: DiscoverResult = {
  leads: [{
    company, domain, evidence_url: evidence, evidence_quote: quote, signal: quote, signal_date: '2026-11-20',
    person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
    confidence: 'high', why: '',
  }],
  seen: [{ url: evidence, title: company, page_age: null, text: `Posted on November 20, 2026. ${quote}.` }],
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 },
  stop: 'end_turn', model: 'claude-opus-5-5', note: null,
}

async function adopted(t: TestContext, rows: CrawlRow[]) {
  t.mock.method(Date, 'now', () => now)
  const crawlSetting = process.env.SITECRAWL_ENABLED
  process.env.SITECRAWL_ENABLED = '1'
  t.after(() => {
    if (crawlSetting === undefined) delete process.env.SITECRAWL_ENABLED
    else process.env.SITECRAWL_ENABLED = crawlSetting
  })

  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  const master = randomBytes(32)
  saveKey(db, tenant, 'anthropic', 'sk-ant-fixture', master)
  const id = createQueryJob(db, tenant, { query: 'Dentists in Austin, TX', seller: 'Dental supplies' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  let savedLeadId: string | undefined
  assert.equal(await runJob(db, job, {
    master, discover: true, discoverImpl: async () => found, enrichImpl: null,
    fetchImpl: async () => new Response('fixture has no external reads', { status: 403 }),
    crawlGet: async url => {
      if (url !== evidence) return { status: 404, body: '', finalUrl: url }
      // Seed at the crawler's persistence boundary, after its per-lead cleanup.
      // The strict parser would ordinarily prevent these conflicting rows.
      savedLeadId = db.prepare('SELECT id FROM leads WHERE scan_job_id = ?').pluck().get(id) as string | undefined
      assert.ok(savedLeadId)
      for (const row of rows) addEnrichment(db, tenant, savedLeadId, {
        ...row, connector: 'sitecrawl', label: 'fixture contact proof', confidence: null,
        source_date: '2026-11-26', retrieved_at: now / 1000,
      })
      return { status: 200, body: `<html><body>${quote}</body></html>`, finalUrl: url }
    },
  }), 'done')
  assert.ok(savedLeadId, 'the post-finish crawler ran')
  const contacts = enrichmentsForLeads(db, tenant, [savedLeadId])[savedLeadId] ?? []
  const select = (row: Enrichment) => ({ kind: row.kind, value: row.value, source_url: row.source_url })
  assert.deepEqual(contacts.filter(row => row.connector === 'sitecrawl' && ['person', 'email'].includes(row.kind)).map(select), rows)
  return contacts.filter(row => row.connector === 'discover' && ['person', 'email'].includes(row.kind)).map(select)
}

test('Discovery adopts a single crawled buyer and their address from the same page', async t => {
  assert.deepEqual(await adopted(t, [buyer, email]), [buyer, email])
})

test('Discovery keeps the crawled buyer but refuses an address proved on a different page', async t => {
  const elsewhere = { ...email, source_url: `${home}contact` }
  assert.deepEqual(await adopted(t, [buyer, elsewhere]), [buyer])
})

test('Discovery refuses to choose between two crawled buyers', async t => {
  const other = { ...buyer, value: 'Alex Lee, Practice Manager' }
  assert.deepEqual(await adopted(t, [buyer, other, email]), [])
})
