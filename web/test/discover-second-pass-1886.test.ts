import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

const model = 'claude-sonnet-5-5'
const evidenceUrl = 'https://fixture.example/announcement'
const date = new Date().toISOString().slice(0, 10)
const quote = 'Cedar Fixture announced that it is opening a second office.'
const lead = {
  company: 'Cedar Fixture', signal: 'Opening a second office', signal_date: date,
  evidence_url: evidenceUrl, evidence_quote: quote, confidence: 'high',
}

async function fixture({ paused }: { paused: boolean }) {
  const raw = new Database(':memory:')
  const master = randomBytes(32)
  const allowances: number[] = []
  try {
    migrateAllSqlite(raw)
    saveKey(raw, 'fixture1886', 'anthropic', 'synthetic-fixture', master)
    const id = createQueryJob(raw, 'fixture1886', {
      query: 'Find businesses opening a second office', seller: 'Office fitting',
      ...(paused ? {} : { runBudget: JSON.stringify({ max_usd: 0.75 }) }),
    })
    const job = claimKeyedJob(raw, id)
    assert.ok(job)
    const fetchImpl: typeof fetch = async (url, init) => {
      if (!init?.body) return new Response('<p>' + date + ' ' + quote + '</p>')
      const body = JSON.parse(String(init.body)) as { model: string; tools: { name: string; max_uses?: number }[] }
      assert.equal(body.model, model, String(url))
      const allowance = body.tools.find(tool => tool.name === 'web_search')?.max_uses ?? 0
      allowances.push(allowance)
      const first = allowances.length === 1
      const hasCandidate = allowance > 0 && (paused ? first : !first)
      return sseResponse(sseEvents({
        id: 'msg_fixture1886', model, stop_reason: paused && first ? 'pause_turn' : 'end_turn',
        content: [
          ...(hasCandidate ? [{
            type: 'web_search_tool_result', tool_use_id: 'srvtoolu_fixture',
            content: [{ type: 'web_search_result', url: evidenceUrl, title: 'Cedar Fixture announcement', encrypted_content: 'fixture', page_age: date }],
          }] : []),
          { type: 'text', text: '<json>' + JSON.stringify({ leads: hasCandidate ? [lead] : [], note: null }) + '</json>' },
        ],
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: allowance } },
      }))
    }
    assert.equal(await runJob(raw, job, { master, discover: true, enrichImpl: null, fetchImpl }), 'done')
    const scan = raw.prepare('SELECT candidates FROM scan_jobs WHERE id = ?').get(id) as { candidates: number }
    const searches = raw.prepare('SELECT sum(used) AS used FROM scan_native_search_calls WHERE scan_job_id = ?').get(id) as { used: number }
    const spend = raw.prepare('SELECT reserve_usd, actual_usd, status FROM scan_spend_calls WHERE scan_job_id = ?').get(id) as { reserve_usd: number; actual_usd: number; status: string }
    return { allowances, candidates: scan.candidates, used: searches.used, spend }
  } finally {
    raw.close()
  }
}

test('#1886 the small run spends ten searches on its first pass and finds a candidate on its second', async () => {
  const r = await fixture({ paused: false })
  assert.equal(r.candidates, 1)
  assert.deepEqual(r.allowances, [10, 5])
  assert.equal(r.used, 15)
  assert.equal(r.spend.reserve_usd, 0.75)
  assert.equal(r.spend.status, 'settled')
  assert.ok(r.spend.actual_usd > 0 && r.spend.actual_usd <= 0.75)
})

test('#1886 a paused turn at the durable ceiling keeps the candidate it already found', async () => {
  const r = await fixture({ paused: true })
  assert.equal(r.candidates, 1)
  assert.deepEqual(r.allowances, [15])
  assert.equal(r.used, 15)
  assert.equal(r.spend.status, 'settled')
})
