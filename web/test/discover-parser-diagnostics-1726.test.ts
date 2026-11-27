import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { parseLeads } from '../lib/discover/agent.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob } from '../lib/scan/store.ts'

const lead = { company: 'Example Workshop', signal: 'Opening another venue', evidence_url: 'https://example.test/news' }
const reply = JSON.stringify({ leads: [
  { ...lead, company: null, person: 'Example Person' },
  { ...lead, signal: null },
  { ...lead, evidence_url: 'invalid' },
  lead,
  lead,
] })
const expected = { raw: 5, accepted: 1, missing_company: 1, missing_signal: 1, invalid_source: 1, duplicate: 1 }

test('#1726 parser exposes aggregate reasons without retaining rejected fields', () => {
  const parsed = parseLeads(reply, 10)
  assert.equal(parsed.leads.length, 1)
  assert.deepEqual(Reflect.get(parsed, 'parse_counts'), expected)
})

test('#1726 scan report persists parser counts separately from accepted candidates', async () => {
  const db = new Database(':memory:')
  try {
    const master = randomBytes(32)
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'synthetic-key', master)
    const id = createQueryJob(db, 'workspace', {
      query: 'Independent venues opening a new location in Lyon',
      runBudget: JSON.stringify({ max_usd: 0.3 }),
    })
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const result = await runJob(db, job, {
      master, discover: true, enrichImpl: null,
      fetchImpl: async () => new Response('', { status: 403 }),
      discoverImpl: async () => ({
        ...parseLeads(reply, 10), stop: 'end_turn', model: 'offline', seen: [],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.17 },
      }),
    })
    assert.equal(result, 'done')
    const row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(id) as { report: string }
    const { discover } = JSON.parse(row.report)
    assert.equal(discover.returned, 1)
    assert.equal(discover.shown, 0)
    assert.deepEqual(discover.parse_counts, expected)
    const status = await readScanStatus(sqliteDb(db), 'workspace', id)
    assert.ok(status)
    assert.deepEqual(status.run_report, [JSON.parse(row.report)])
  } finally {
    db.close()
  }
})

test('an unrelated empty answer has zero records and no drop reasons', () => {
  const parsed = parseLeads('{"leads":[]}', 10)
  assert.deepEqual(Reflect.get(parsed, 'parse_counts'), {
    raw: 0, accepted: 0, missing_company: 0, missing_signal: 0, invalid_source: 0, duplicate: 0,
  })
})

test('#1726 scan report distinguishes observed source URLs from search attempts and accepted leads', async () => {
  const db = new Database(':memory:')
  try {
    const master = randomBytes(32)
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'synthetic-key', master)
    const page = { url: 'https://example.test/news', title: null, page_age: null, text: null }
    for (const [seen, count] of [[[], 0], [[page, page, { ...page, url: 'https://example.test/about' }], 2]] as const) {
      const id = createQueryJob(db, 'workspace', {
        query: 'Independent venues opening a new location in Lyon',
        runBudget: JSON.stringify({ max_usd: 0.3 }),
      })
      const job = claimKeyedJob(db, id)
      assert.ok(job)
      assert.equal(await runJob(db, job, {
        master, discover: true, enrichImpl: null,
        fetchImpl: async () => new Response('', { status: 403 }),
        discoverImpl: async () => ({
          ...parseLeads('{"leads":[]}', 10), stop: 'end_turn', model: 'offline', seen: [...seen],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.17 },
        }),
      }), 'done')
      const row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(id) as { report: string }
      const { discover } = JSON.parse(row.report)
      assert.deepEqual([discover.searches, discover.returned, discover.source_urls], [3, 0, count])
      assert.ok(!JSON.stringify(discover).includes('https://example.test/'))
    }
  } finally {
    db.close()
  }
})
