// Per-run explicit budget controls on CSV company-import jobs: a run can narrow
// itself (no paid fallback, no credit enrichment, no judge) for an explicitly
// bounded run. Absent or malformed controls mean current behavior - the control
// only ever narrows, never widens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, getJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { claimKeyedJob, runJob, parseRunBudget, type Judge } from '../lib/scan/runner.ts'
import { createBatch, queuePendingRows, migrateCsv, normalizeRunBudget } from '../lib/scan/csv-import.ts'
import { ENRICH_APOLLO } from '../lib/enrich/index.ts'

const master = randomBytes(32)
// enrichLeadContacts resolves its decryption key from the env when the signals
// caller does not pass one (production sets DAZL_MASTER_KEY); scope it to this file's process.
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateCsv(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  return db
}

const QUOTE = 'Acme announced it is hiring three account executives for the Toronto market'
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const lead = { name: 'Pat', company: 'Acme', contact: null, signal: 'Hiring AEs', source_url: 'https://news.com/acme', score: 80, excerpt: QUOTE, event_date: recent }
const page = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.`, title: 'Acme news', retrievedAt: 1_700_000_000 })

function researchProvider(calls: { n: number }): Record<'anthropic' | 'openai', Provider> {
  return {
    anthropic: { research: async () => { calls.n++; return { text: 'Here: ' + JSON.stringify([lead]), citedUrls: ['https://news.com/acme'] } } },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
}

test('parseRunBudget: absent or malformed means current behavior; only explicit false narrows', () => {
  assert.equal(parseRunBudget(null), null)
  assert.equal(parseRunBudget(undefined), null)
  assert.equal(parseRunBudget(''), null)
  assert.equal(parseRunBudget('not json'), null)
  assert.equal(parseRunBudget('{}'), null)
  assert.equal(parseRunBudget('{"paid_fallback":true}'), null) // true never widens
  assert.equal(parseRunBudget('["paid_fallback"]'), null)
  assert.deepEqual(parseRunBudget('{"paid_fallback":false}'), { paid_fallback: false })
  assert.deepEqual(parseRunBudget('{"judge":false,"credit_enrichment":false,"judge_extra":"x"}'), { judge: false, credit_enrichment: false })
})

test('normalizeRunBudget: absent means current behavior; an explicitly supplied invalid budget is REJECTED, never widened', () => {
  assert.deepEqual(normalizeRunBudget(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeRunBudget(null), { ok: true, value: null })
  assert.equal(normalizeRunBudget('paid_fallback').ok, false)
  assert.equal(normalizeRunBudget([]).ok, false)
  assert.equal(normalizeRunBudget({}).ok, false) // explicit but empty: would silently widen
  assert.equal(normalizeRunBudget({ paid_fallback: true }).ok, false) // only false narrows
  assert.equal(normalizeRunBudget({ paid_fallback: 0 }).ok, false)
  assert.equal(normalizeRunBudget({ unknown_control: false }).ok, false)
  assert.deepEqual(normalizeRunBudget({ paid_fallback: false }), { ok: true, value: '{"paid_fallback":false}' })
  const all = normalizeRunBudget({ paid_fallback: false, credit_enrichment: false, judge: false })
  assert.equal(all.ok, true)
  assert.deepEqual(JSON.parse((all as { value: string }).value), { paid_fallback: false, credit_enrichment: false, judge: false })
})

test('queuePendingRows stores the per-run budget on the job row and claim returns it', () => {
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com', 'beta.io'])
  queuePendingRows(db, 'A', b, JSON.stringify({ paid_fallback: false }))
  const rows = db.prepare('SELECT csv_domain, run_budget FROM scan_jobs ORDER BY csv_domain').all() as { csv_domain: string; run_budget: string | null }[]
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.run_budget === '{"paid_fallback":false}'))
  const job = claimKeyedJob(db)!
  assert.deepEqual(parseRunBudget(job.run_budget), { paid_fallback: false })
  // default: no budget stored
  const b2 = createBatch(db, 'A', ['gamma.io'])
  queuePendingRows(db, 'A', b2)
  const r2 = db.prepare("SELECT run_budget FROM scan_jobs WHERE csv_domain = 'gamma.io'").get() as { run_budget: string | null }
  assert.equal(r2.run_budget, null)
})

test('paid_fallback=false stops the run before the paid research call; no budget keeps current behavior', async () => {
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, JSON.stringify({ paid_fallback: false }))
  const job = claimKeyedJob(db)!
  const calls = { n: 0 }
  assert.equal(await runJob(db, job, { providers: researchProvider(calls), master, fetchPage: page }), 'failed')
  assert.equal(calls.n, 0) // the paid fallback was never attempted
  assert.equal(getJob(db, 'A', job.id)?.error, 'no_candidates')

  const db2 = setup()
  const b2 = createBatch(db2, 'A', ['acme.com'])
  queuePendingRows(db2, 'A', b2)
  const job2 = claimKeyedJob(db2)!
  const calls2 = { n: 0 }
  assert.equal(await runJob(db2, job2, { providers: researchProvider(calls2), master, fetchPage: page }), 'done')
  assert.equal(calls2.n, 1) // control: the fallback runs as today
})

test('judge=false forces the judge off even when the caller provides one', async () => {
  let judged = 0
  const judge: Judge = async () => { judged++; return 'supports' }
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, JSON.stringify({ judge: false }))
  const job = claimKeyedJob(db)!
  const calls = { n: 0 }
  assert.equal(await runJob(db, job, { providers: researchProvider(calls), master, fetchPage: page, judge }), 'done')
  assert.equal(judged, 0)

  let judgedControl = 0
  const judgeControl: Judge = async () => { judgedControl++; return 'supports' }
  const db2 = setup()
  const b2 = createBatch(db2, 'A', ['acme.com'])
  queuePendingRows(db2, 'A', b2)
  const job2 = claimKeyedJob(db2)!
  const calls2 = { n: 0 }
  assert.equal(await runJob(db2, job2, { providers: researchProvider(calls2), master, fetchPage: page, judge: judgeControl }), 'done')
  assert.ok(judgedControl > 0) // control: the judge runs as today
})

function recordingFetch(urls: string[]) {
  return (async (url: string | URL) => {
    urls.push(String(url))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

test('credit_enrichment=false skips the BYOK Apollo pass; default still runs it', async () => {
  const urls: string[] = []
  const db = setup()
  saveCredential(db, 'A', ENRICH_APOLLO, 'test-apollo-key', master)
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, JSON.stringify({ credit_enrichment: false }))
  const job = claimKeyedJob(db)!
  const calls = { n: 0 }
  assert.equal(await runJob(db, job, { providers: researchProvider(calls), master, fetchPage: page, fetchImpl: recordingFetch(urls) }), 'done')
  assert.equal(urls.filter(u => u.includes('api.apollo.io')).length, 0)

  const urls2: string[] = []
  const db2 = setup()
  saveCredential(db2, 'A', ENRICH_APOLLO, 'test-apollo-key', master)
  const b2 = createBatch(db2, 'A', ['acme.com'])
  queuePendingRows(db2, 'A', b2)
  const job2 = claimKeyedJob(db2)!
  const calls2 = { n: 0 }
  assert.equal(await runJob(db2, job2, { providers: researchProvider(calls2), master, fetchPage: page, fetchImpl: recordingFetch(urls2) }), 'done')
  assert.ok(urls2.some(u => u.includes('api.apollo.io'))) // control: the credit pass runs as today
})
