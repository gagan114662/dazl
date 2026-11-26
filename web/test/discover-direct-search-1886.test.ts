import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

test('#1886 direct search followed by a proof-page fetch yields a discovery lead', async () => {
  const db = new Database(':memory:')
  const master = randomBytes(32)
  const now = new Date().toISOString().slice(0, 10)
  const company = 'Cedar Fixture'
  const evidence = 'Cedar Fixture announced that it is opening its second office.'
  const url = 'https://fixture.example/announcement'
  const toolTypes = ['web_search_20250305', 'web_fetch_20250910']
  const requests: { name: string; type: string; max_uses?: number; allowed_callers?: string[] }[][] = []
  try {
    migrateAllSqlite(db)
    saveKey(db, 'fixture1886', 'anthropic', 'synthetic-fixture', master)
    const id = createQueryJob(db, 'fixture1886', {
      query: 'Find businesses opening a second office',
      seller: 'Office fitting',
      runBudget: JSON.stringify({ max_usd: 0.30 }),
    })
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const fetchImpl: typeof fetch = async (_endpoint, init) => {
      if (!init?.body) return new Response('<p>' + now + ' ' + evidence + '</p>')
      const body = JSON.parse(String(init.body)) as { model: string; tools: typeof requests[number] }
      requests.push(body.tools)
      assert.deepEqual(body.tools.map(tool => tool.type), toolTypes)
      return sseResponse(sseEvents({
        id: 'msg_fixture1886_direct', model: body.model, stop_reason: 'end_turn',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_search', name: 'web_search', input: { query: 'business expansion announcement' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_search',
            content: [{ type: 'web_search_result', url, title: company, encrypted_content: 'fixture', page_age: now }] },
          { type: 'server_tool_use', id: 'srvtoolu_fetch', name: 'web_fetch', input: { url } },
          { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_fetch',
            content: { type: 'web_fetch_result', url, content: { type: 'document', title: company, source: { type: 'text', media_type: 'text/plain', data: now + ' ' + evidence } } } },
          { type: 'text', text: '<json>' + JSON.stringify({ request_plan: { offer: null, buyer_type: null, industry_code: null, places: [], signals: [], exclusions: [], language: 'en' },
            leads: [{ company, country: 'US', location_evidence: 'United States', signal: 'Opening its second office',
            signal_date: now, evidence_url: url, evidence_quote: evidence, confidence: 'high' }] }) + '</json>' },
        ],
        usage: { input_tokens: 20000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          server_tool_use: { web_search_requests: 1, web_fetch_requests: 1 } },
      }))
    }
    const outcome = await runJob(db, job, { master, discover: true, enrichImpl: null, fetchImpl })
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].map(tool => [tool.name, tool.type]), [
      ['web_search', 'web_search_20250305'], ['web_fetch', 'web_fetch_20250910'],
    ])
    assert.equal(outcome, 'done')
    assert.equal(requests[0][0].max_uses, 5)
    assert.equal(requests[0][0].allowed_callers, undefined)
    assert.equal((db.prepare('SELECT candidates FROM scan_jobs WHERE id = ?').get(id) as { candidates: number }).candidates, 1)
    assert.deepEqual(db.prepare('SELECT company, source_url FROM leads WHERE scan_job_id = ?').all(id), [{ company, source_url: url }])
    const spend = db.prepare('SELECT reserve_usd, actual_usd, status FROM scan_spend_calls WHERE scan_job_id = ?').get(id) as { reserve_usd: number; actual_usd: number; status: string }
    assert.equal(spend.reserve_usd, 0.30)
    assert.equal(spend.status, 'settled')
    assert.ok(spend.actual_usd > 0 && spend.actual_usd <= spend.reserve_usd)
  } finally {
    db.close()
  }
})
