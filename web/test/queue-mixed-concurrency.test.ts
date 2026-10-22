// Regression: mixed tenant mode must NOT raise the concurrency ceiling.
// Legacy loop and queue bridge share one slot budget (run-slots.ts); with
// SCAN_MAX_CONCURRENT=3 and both runner types active, in-flight provider
// research calls never exceed 3 in total.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { anthropicProvider, openaiProvider, type Provider } from '../lib/llm/provider.ts'
import { migrateScan, createJob, getJob } from '../lib/scan/store.ts'
import { kickRunner } from '../lib/scan/runner.ts'

const master = randomBytes(32)
const input = { business_name: 'Acme', industry: 'roofing', location: 'Toronto' }
const QUOTE = 'Acme announced it is hiring three account executives for the Toronto market'
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const lead = { name: 'Pat', company: 'Acme', contact: null, signal: 'Hiring', source_url: 'https://a.com/x', score: 80, excerpt: QUOTE, event_date: recent }
const page = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}.`, title: 't', retrievedAt: 1_700_000_000 })

test('mixed mode: combined in-flight runs never exceed SCAN_MAX_CONCURRENT', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  saveKey(db, 'alice', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  saveKey(db, 'bob', 'anthropic', 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', master)
  for (let i = 0; i < 3; i++) createJob(db, 'alice', input) // queue tenant
  for (let i = 0; i < 4; i++) createJob(db, 'bob', input)   // legacy tenant

  let inFlight = 0
  let maxInFlight = 0
  const slow = async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 60))
    inFlight--
    return { text: 'Here: ' + JSON.stringify([lead]), citedUrls: ['https://a.com/x'] }
  }
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: slow },
    openai: { research: slow },
  }
  // Post-finish enrichment (EDGAR/ATS/RSS) uses deps.fetchImpl, NOT the
  // sitecrawl flag - without this stub a direct node --test run would attempt
  // real egress. npm test's global fence is the harness-level backstop; the
  // test itself must be egress-free either way.
  const fetchImpl = async () => new Response('{}', { status: 200 })
  const savedEnv = process.env.DAZL_QUEUE_TENANTS
  const savedCrawl = process.env.SITECRAWL_ENABLED
  process.env.DAZL_QUEUE_TENANTS = 'alice'
  process.env.SITECRAWL_ENABLED = '0' // npm test sets this globally; keep the test self-contained
  try {
    // Drain: kick repeatedly until every job is done.
    for (let i = 0; i < 60; i++) {
      await kickRunner(db, { providers, master, fetchPage: page, fetchImpl })
      await new Promise((r) => setTimeout(r, 80))
      const remaining = (db.prepare("SELECT count(*) c FROM scan_jobs WHERE status IN ('pending','running')").get() as { c: number }).c
      if (remaining === 0) break
    }
  } finally {
    if (savedEnv === undefined) delete process.env.DAZL_QUEUE_TENANTS
    else process.env.DAZL_QUEUE_TENANTS = savedEnv
    if (savedCrawl === undefined) delete process.env.SITECRAWL_ENABLED
    else process.env.SITECRAWL_ENABLED = savedCrawl
  }
  assert.ok(maxInFlight <= 3, `combined ceiling held (saw ${maxInFlight})`)
  assert.ok(maxInFlight >= 2, 'both runner types actually ran concurrently (test is meaningful)')
  const remaining = (db.prepare("SELECT count(*) c FROM scan_jobs WHERE status IN ('pending','running')").get() as { c: number }).c
  assert.equal(remaining, 0, 'all 7 jobs drained')
  // Both worlds completed: alice via queue, bob via legacy.
  for (const tenant of ['alice', 'bob']) {
    const rows = db.prepare("SELECT status FROM scan_jobs WHERE user_id = ?").all(tenant) as { status: string }[]
    assert.ok(rows.every(r => r.status === 'done'), `${tenant} jobs done`)
  }
})
