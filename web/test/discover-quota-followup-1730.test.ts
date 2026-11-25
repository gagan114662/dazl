import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { discoverLeads, type DiscoveredLead } from '../lib/discover/agent.ts'
import { enrichLeads } from '../lib/discover/enrich.ts'
import { createSearchBudget, type SearchBudget } from '../lib/discover/search-budget.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { runClaudeWebSearch } from '../lib/llm/claude-web-search.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { migrateScanSpendCap, runWithScanSpend, scanCapConfig } from '../lib/scan/spend-cap.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

const key = 'synthetic-fixture'
const tokens = { input_tokens: 10, output_tokens: 2, server_tool_use: { web_search_requests: 0 } }
const lead: DiscoveredLead = {
  company: 'Fixture Company', signal: 'Opening a new branch', evidence_url: 'https://proof.example/branch',
  domain: null, person: null, title: null, person_source_url: null, linkedin_url: null,
  email: null, email_source_url: null, signal_date: null, evidence_quote: null, confidence: 'high', why: '',
}
const reply = (model: string, usage: Record<string, unknown>, content: string) =>
  sseResponse(sseEvents({ id: 'msg_quota_fixture', model, stop_reason: 'end_turn', usage, content: [{ type: 'text', text: content }] }))

function jobFixture() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const master = randomBytes(32)
  saveKey(db, 'fixture-tenant', 'anthropic', key, master)
  const id = createQueryJob(db, 'fixture-tenant', { query: 'Find companies opening a branch', seller: 'Shop fit-out' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const inJob = <T>(fn: () => Promise<T>) => runWithScanSpend({
    db, jobId: id, tenantId: job.user_id, attempt: job.attempts,
    cap: scanCapConfig({}), accountLimits: null, nativeSearch: true,
  }, fn)
  return { db, master, id, job, inJob }
}

test('a native request stops with a typed quota exhaustion before token count or paid dispatch', async () => {
  const { db, inJob } = jobFixture()
  try {
    await inJob(() => createSearchBudget().reserve(15))
    const fetchImpl: typeof fetch = async () => assert.fail('an exhausted quota cannot dispatch')
    await assert.rejects(inJob(() => runClaudeWebSearch(key, 'Find buyers', () => null, fetchImpl)),
      { name: 'NativeSearchBudgetExhausted' })
  } finally { db.close() }
})

test('SQLite reruns do not backfill a new scan with a money hold before its first native reservation', async () => {
  const { db, id, job, inJob } = jobFixture()
  try {
    db.prepare(`INSERT INTO scan_spend_calls (id,user_id,scan_job_id,attempt,kind,reserve_usd,status,created_at)
      VALUES ('held',?,?,?,'llm.anthropic.web_search',1,'reserved',0)`).run(job.user_id, id, job.attempts)
    migrateScanSpendCap(db)
    assert.equal((await inJob(() => createSearchBudget().reserve(15))).allowance, 15)
  } finally { db.close() }
})

test('SQLite still retains legacy search allowance when the native ledger is first created', async () => {
  const { db, id, job, inJob } = jobFixture()
  try {
    db.exec('DROP TABLE scan_native_search_calls')
    db.prepare(`INSERT INTO scan_spend_calls (id,user_id,scan_job_id,attempt,kind,reserve_usd,status,created_at)
      VALUES ('legacy-fixture',?,?,?,'llm.anthropic.web_search',1,'reserved',0)`).run(job.user_id, id, job.attempts)
    migrateScanSpendCap(db)
    assert.equal((await inJob(() => createSearchBudget().reserve(15))).allowance, 0)
  } finally { db.close() }
})

test('discovery accounts for an uncached response with omitted cache counters', async () => {
  const result = await discoverLeads({ query: 'Find buyers' }, {
    apiKey: key, fetch: async () => reply('claude-sonnet-5-5', tokens, '{"leads":[]}'),
  })
  assert.equal(result.usage.requests, 1)
  assert.deepEqual([result.usage.cache_read_tokens, result.usage.cache_write_tokens], [0, 0])
})

test('enrichment accounts for explicit null cache counters', async () => {
  const result = await enrichLeads([lead], {}, {
    apiKey: key, fetch: async () => reply('claude-haiku-5-5', {
      ...tokens, cache_read_input_tokens: null, cache_creation_input_tokens: null,
    }, '{}'),
  })
  assert.equal(result.usage.requests, 1)
  assert.equal(result.accountingUncertain, false)
  assert.deepEqual([result.usage.cache_read_tokens, result.usage.cache_write_tokens], [0, 0])
})

test('a peer that stops before sending refunds its unused reservation', async () => {
  const settled: unknown[] = []
  let reservations = 0
  let sends = 0
  const firstSend = Promise.withResolvers<void>()
  const budget: SearchBudget = {
    async reserve() {
      if (++reservations === 2) {
        await firstSend.promise
        await setImmediate()
      }
      return { allowance: 4, async settle(used) { settled.push(used) } }
    },
  }
  const result = await enrichLeads([lead, { ...lead, company: 'Second Fixture' }], {}, {
    apiKey: key, searchBudget: budget,
    fetch: async () => {
      sends++
      firstSend.resolve()
      throw new Error('fixture transport failure')
    },
  }, 2)
  assert.equal(result.accountingUncertain, true)
  assert.equal(sends, 1)
  assert.deepEqual(settled, [0], 'only the call that never sent releases its reservation')
})

test('a runner native quota write failure stops before any provider request', async () => {
  const { db, id, job, master } = jobFixture()
  try {
    db.exec(`CREATE TRIGGER reject_native_quota BEFORE INSERT ON scan_native_search_calls
      BEGIN SELECT RAISE(ABORT, 'fixture quota write refused'); END`)
    let sends = 0
    const outcome = await runJob(db, job, {
      master, discover: true,
      fetchImpl: async () => { sends++; return new Response('unexpected provider request', { status: 503 }) },
    })
    assert.equal(outcome, 'failed')
    assert.equal(sends, 0)
    assert.deepEqual(db.prepare('SELECT status,error FROM scan_jobs WHERE id=?').get(id), { status: 'failed', error: 'source_error' })
  } finally { db.close() }
})
