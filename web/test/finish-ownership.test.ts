// A stale attempt (re-claimed by a newer one) must not run ANY post-finish
// side effect: no watch marks, no seen-flags, no crawl, no enrichment, no
// autopilot trigger. The owned path must keep them all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import type { Provider } from '../lib/llm/provider.ts'
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
  // The suite disables crawling globally; enable it for this test only.
  const saved = process.env.SITECRAWL_ENABLED
  process.env.SITECRAWL_ENABLED = '1'
  try {
    const out = await runJob(db, job, { providers, master, fetchPage: page, crawlGet: async () => { crawls++; throw new Error('no net in test') } })
    assert.equal(out, 'done')
    assert.equal(listLeads(db, 'A', job.id).length, 1)
    assert.ok(crawls > 0, 'owned run reaches the crawl side effect')
  } finally {
    if (saved === undefined) delete process.env.SITECRAWL_ENABLED
    else process.env.SITECRAWL_ENABLED = saved
  }
})

test('already stale ordinary claim refuses before research or post-finish effects', async () => {
  const db = setup()
  try {
    const id = createJob(db, 'A', input)
    const stale = claimKeyedJob(db)!
    const fresh = takeOver(db, id)
    assert.equal(fresh.attempts, 2)
    let research = 0
    let crawls = 0
    const counted = { ...providers, anthropic: { research: async (...args: Parameters<Provider['research']>) => {
      research++
      return providers.anthropic.research(...args)
    } } }
    assert.equal(await runJob(db, stale, { providers: counted, master, fetchPage: page,
      crawlGet: async () => { crawls++; throw new Error('no net in test') } }), 'failed')
    assert.equal(research, 0)
    assert.equal(crawls, 0)
    assert.equal(listLeads(db, 'A', id).length, 0)
    assert.deepEqual(db.prepare('SELECT status, attempts FROM scan_jobs WHERE id = ?').get(id), {status:'running', attempts:2})
  } finally { db.close() }
})

function takeOver(db: Database.Database, id: string) {
  db.prepare("UPDATE scan_jobs SET status='pending' WHERE id = ?").run(id)
  return claimKeyedJob(db)!
}

test('attempt overtaken during research: finish no-ops AND zero post-finish effects fire', async () => {
  const db = setup()
  const id = createJob(db, 'A', input)
  const stale = claimKeyedJob(db)! // attempts = 1
  let research = 0
  const overtaken = { ...providers, anthropic: { research: async (...args: Parameters<Provider['research']>) => {
    if (++research === 1) assert.equal(takeOver(db, id).attempts, 2)
    return providers.anthropic.research(...args)
  } } }
  let crawls = 0
  const saved = process.env.SITECRAWL_ENABLED
  process.env.SITECRAWL_ENABLED = '1'
  try {
    const out = await runJob(db, stale, { providers: overtaken, master, fetchPage: page, crawlGet: async () => { crawls++; throw new Error('no net in test') } })
    assert.equal(out, 'done', 'a completed calculation does not give the stale attempt ownership')
    assert.ok(research > 0, 'this exercises finish after a successful entry check')
    assert.equal(listLeads(db, 'A', id).length, 0, 'stale finish wrote no leads')
    assert.equal(crawls, 0, 'stale run never reaches crawl/enrich/autopilot side effects')
  } finally {
    if (saved === undefined) delete process.env.SITECRAWL_ENABLED
    else process.env.SITECRAWL_ENABLED = saved
  }
  // The fresh attempt is untouched: still running, owns the row.
  const row = db.prepare('SELECT status, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; attempts: number }
  assert.deepEqual(row, { status: 'running', attempts: 2 })
})

test('stale CSV-batch attempt: owned-gate blocks seen-flags, crawl and enrichment', async () => {
  const { createBatch, queuePendingRows, migrateCsv } = await import('../lib/scan/csv-import.ts')
  const db = setup()
  const { migratePlans } = await import('../lib/plans.ts')
  const { setPlan } = await import('./helpers/plan-fixture.ts')
  migratePlans(db)
  setPlan(db, 'A', 'pro')
  migrateCsv(db)
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b)
  const stale = claimKeyedJob(db)! // attempts = 1
  let research = 0
  const csvProviders = { ...providers, anthropic: { research: async (...args: Parameters<Provider['research']>) => {
    if (++research === 1) assert.equal(takeOver(db, stale.id).attempts, 2)
    return providers.anthropic.research(...args)
  } } }
  let crawls = 0
  const saved = process.env.SITECRAWL_ENABLED
  process.env.SITECRAWL_ENABLED = '1'
  try {
    const out = await runJob(db, stale, { providers: csvProviders, master, fetchPage: page, crawlGet: async () => { crawls++; throw new Error('no net in test') } })
    assert.equal(out, 'done')
    assert.ok(research > 0, 'this exercises CSV finish after a successful entry check')
    assert.equal(listLeads(db, 'A', stale.id).length, 0, 'stale CSV finish wrote no leads')
    assert.equal(crawls, 0, 'stale CSV run never crawls the fresh attempt\'s leads')
  } finally {
    if (saved === undefined) delete process.env.SITECRAWL_ENABLED
    else process.env.SITECRAWL_ENABLED = saved
  }
  const row = db.prepare('SELECT status, attempts FROM scan_jobs WHERE id = ?').get(stale.id) as { status: string; attempts: number }
  assert.deepEqual(row, { status: 'running', attempts: 2 })
})
