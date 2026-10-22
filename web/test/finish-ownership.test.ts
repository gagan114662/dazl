// A stale attempt (re-claimed by a newer one) must not run ANY post-finish
// side effect: no watch marks, no seen-flags, no crawl, no enrichment, no
// autopilot trigger. The owned path must keep them all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { anthropicProvider, openaiProvider, type Provider } from '../lib/llm/provider.ts'
import { migrateScan, createJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'

const master = randomBytes(32)
const input = { business_name: 'Acme Roofing', industry: 'roofing', location: 'Toronto' }
const QUOTE = 'Northside Builders announced it is hiring three roofing crews for the Toronto market'
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const lead = { name: 'Pat', company: 'Northside Builders', contact: null, signal: 'Hiring', source_url: 'https://a.com/x', score: 80, excerpt: QUOTE, event_date: recent }
const page = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.`, title: 't', retrievedAt: 1_700_000_000 })
const providers: Record<'anthropic' | 'openai', Provider> = {
  anthropic: { research: async () => ({ text: 'Here: ' + JSON.stringify([lead]), citedUrls: ['https://a.com/x'] }) },
  openai: { research: async () => ({ text: '[]', citedUrls: [] }) },
}

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  return db
}

test('owned attempt: leads land and post-finish side effects run (crawl attempted)', async () => {
  const db = setup()
  createJob(db, 'A', input)
  const job = claimKeyedJob(db)!
  let crawls = 0
  const out = await runJob(db, job, { providers, master, fetchPage: page, crawlGet: async () => { crawls++; throw new Error('no net in test') } })
  assert.equal(out, 'done')
  assert.equal(listLeads(db, 'A', job.id).length, 1)
  assert.ok(crawls > 0, 'owned run reaches the crawl side effect')
})

test('stale attempt: finish no-ops AND zero post-finish side effects fire', async () => {
  const db = setup()
  const id = createJob(db, 'A', input)
  const stale = claimKeyedJob(db)! // attempts = 1
  // A newer attempt takes over (what reapStaleJobs + re-claim does).
  db.prepare("UPDATE scan_jobs SET status='pending' WHERE id = ?").run(id)
  const fresh = claimKeyedJob(db)!
  assert.equal(fresh.attempts, 2)
  let crawls = 0
  const out = await runJob(db, stale, { providers, master, fetchPage: page, crawlGet: async () => { crawls++; throw new Error('no net in test') } })
  assert.equal(out, 'done', 'stale run still reports done; the queue bridge token rejects the mapping')
  assert.equal(listLeads(db, 'A', id).length, 0, 'stale finish wrote no leads')
  assert.equal(crawls, 0, 'stale run never reaches crawl/enrich/autopilot side effects')
  // The fresh attempt is untouched: still running, owns the row.
  const row = db.prepare('SELECT status, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; attempts: number }
  assert.deepEqual(row, { status: 'running', attempts: 2 })
})
