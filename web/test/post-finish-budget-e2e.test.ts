import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createJob, getJob } from '../lib/scan/store.ts'
import { kickRunner } from '../lib/scan/runner.ts'
import { slotAvailable, acquireSlot, releaseSlot } from '../lib/scan/run-slots.ts'

// runJob-level proof of the bounded post-processing slice via the deps seam
// (no network anywhere: provider/fetchPage/fetchImpl/crawlGet all stubbed).
// The crawlGet stub models an abort-HONORING slow request (settles at 300ms);
// the force-destroy property of the real rawGet path is proven separately in
// post-finish-budget.test.ts. Under test here: the deadline fires mid-crawl,
// orchestration stops starting new work, runJob settles, slot is released.
const master = randomBytes(32)
const input = { business_name: 'Acme', industry: 'roofing', location: 'Toronto' }
const QUOTE = 'Acme announced it is hiring three account executives for the Toronto market'
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const lead = { name: 'Pat', company: 'Acme', contact: null, signal: 'Hiring', source_url: 'https://a.com/x', score: 80, excerpt: QUOTE, event_date: recent }
const page = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}.`, title: 't', retrievedAt: 1_700_000_000 })

function probeActive(): number { let n = 0; while (slotAvailable()) { acquireSlot(); n++ } for (let i = 0; i < n; i++) releaseSlot(); return 3 - n }

test('post-finish deadline: runJob settles and the slot is released (egress-free seam)', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  saveKey(db, 'bob', 'anthropic', 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', master)
  createJob(db, 'bob', input)
  const fast = async () => ({ text: 'Here: ' + JSON.stringify([lead]), citedUrls: ['https://a.com/x'] })
  const providers: any = { anthropic: { research: fast }, openai: { research: fast } }
  let crawls = 0
  const crawlGet = async () => { crawls++; await new Promise((r) => setTimeout(r, 300)); return null }
  const saved = process.env.SCAN_POST_FINISH_BUDGET_MS
  const savedCrawl = process.env.SITECRAWL_ENABLED
  process.env.SCAN_POST_FINISH_BUDGET_MS = '150'
  process.env.SITECRAWL_ENABLED = '1'
  try {
    const t0 = Date.now()
    await kickRunner(db, { providers, master, fetchPage: page, fetchImpl: (async () => new Response('{}')) as typeof fetch, crawlGet: crawlGet as never })
    // Wait for the run to SETTLE (slot released), not merely for finish() to
    // write 'done' - post-finish work is exactly what the deadline bounds.
    for (let i = 0; i < 50 && probeActive() !== 0; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const elapsed = Date.now() - t0
    const job = getJob(db, 'bob', (db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id)
    assert.equal(job?.status, 'done', 'job completed despite the deadline')
    assert.ok(elapsed < 4000, `settled near the deadline, not the full crawl tail (${elapsed}ms)`)
    assert.equal(probeActive(), 0, 'slot released after settle - nothing leaked')
    assert.ok(crawls <= 2, `no new crawl work started after the deadline (crawls=${crawls})`)
  } finally {
    if (saved === undefined) delete process.env.SCAN_POST_FINISH_BUDGET_MS
    else process.env.SCAN_POST_FINISH_BUDGET_MS = saved
    if (savedCrawl === undefined) delete process.env.SITECRAWL_ENABLED
    else process.env.SITECRAWL_ENABLED = savedCrawl
  }
})
