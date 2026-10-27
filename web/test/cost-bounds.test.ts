import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { resetTinyfishState, limits } from '../lib/search/tinyfish.ts'
import { resetSpendPools, PRICES_USD_PER_M } from '../lib/llm/spend-guard.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { migrateWatch, createWatch, runDueWatches } from '../lib/watch.ts'
import { MAX_COMPANIES } from '../lib/people/people-search.ts'
import { BUDGET_EXCLUDED_PATHS, DEFAULT_TINYFISH, PEOPLE_SEARCHES_MAX, describeRunBudget, profileGenerationWorstCaseUsd } from '../lib/scan/run-budget.ts'

// The remaining paths around the PARTIAL per-run budget (STATUS "Next"; #216/#217 follow-up). Stubs only, no network, no price.
// max_usd stays a reservation limit on guarded model requests; this file pins what ELSE bounds (or does not bound) each path.
const master = randomBytes(32); process.env.DAZL_MASTER_KEY = master.toString('base64')

test('the numbers the disclosure states are the numbers the code enforces', () => {
  const l = limits({})
  assert.deepEqual([DEFAULT_TINYFISH.searchesPerScan, DEFAULT_TINYFISH.fetchesPerScan, DEFAULT_TINYFISH.tenantDaily], [l.searchesPerScan, l.fetchesPerScan, l.tenantDaily])
  assert.equal(PEOPLE_SEARCHES_MAX, MAX_COMPANIES)
  const w = profileGenerationWorstCaseUsd()
  assert.ok(w > 0.001 && w < 0.05, `profile generation worst case is cents or less: ${w}`)
  const p = PRICES_USD_PER_M['claude-sonnet-4-5']; assert.ok(w > 800 * p.out / 1e6, 'includes the 800 output tokens')
})

test('the disclosure names every path and what bounds it, and still says it is not a whole-scan ceiling', () => {
  const all = BUDGET_EXCLUDED_PATHS.join('\n')
  for (const re of [/Profile generation[^\n]*about \$0\.\d+ worst case/, /TinyFish search and fetch[^\n]*COUNT, not dollars[^\n]*8 searches and 16 fetched pages/, /People search[^\n]*at most 5/, /Autopilot[^\n]*does NOT start autopilot/, /Weekly watches take their own budget/, /CSV imports take the narrowing flags only/, /NOT BOUNDED AT ALL: retries below dazl/, /NOT BOUNDED ACROSS RESTARTS: the per-owner pool/])
    assert.match(all, re)
  const d = describeRunBudget({ max_usd: 1 })
  assert.equal(d.scope, 'partial'); assert.match(d.ceiling, /not a whole-scan dollar ceiling/)
  assert.equal(d.surfaces.find(s => s.surface === 'autopilot')!.status, 'off')
})

// A successful stubbed scan, so the post-scan autopilot step is reached.
async function runScan(budget: string | null) {
  resetTinyfishState(); resetSpendPools()
  const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
  const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
  const lead = { company: 'Harbor Freight Supply', name: 'Pat Lee', contact: null, signal: 'Hiring a payroll specialist', score: 80, excerpt: QUOTE, source_url: 'https://jobs.example/hf', event_date: recent }
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  db.exec('CREATE TABLE users (id TEXT, business_name TEXT)'); db.prepare('INSERT INTO users VALUES (?, ?)').run('A', 'Acme') // the post-scan step reads the business name
  const id = createQueryJob(db, 'A', { query: 'Find Ohio companies hiring a payroll specialist', icp: JSON.stringify({ summary: 's', who: ['Controller'], industries: [], sizes: [], where: ['Ohio'], signals: ['payroll job'], exclude: [] }), runBudget: budget })
  const job = claimKeyedJob(db, id)!
  const providers: Record<'anthropic' | 'openai', Provider> = { anthropic: { research: async () => ({ text: JSON.stringify([lead]), citedUrls: [lead.source_url] }), complete: async () => 'supports' }, openai: { research: async () => ({ text: '', citedUrls: [] }) } }
  let autopilot = 0
  const r = await runJob(db, job, { providers, master, fetchPage: async () => ({ text: `Posted ${recent}. ${QUOTE}. Apply now.`, title: 'Jobs', retrievedAt: 1 }), score: false, ground: false, autopilot: (async () => { autopilot++; return { sent: 0, held: 0, skipped: 0 } }) as never })
  return { r, autopilot, status: (db.prepare('SELECT status FROM scan_jobs').get() as { status: string }).status }
}
test('autopilot: a job that carries a budget never starts it; an unbudgeted job still does (control)', async () => {
  const control = await runScan(null)
  assert.equal(control.status, 'done'); assert.equal(control.autopilot, 1, 'fixture precondition: the post-scan autopilot step is reached')
  for (const b of ['{"max_usd":5}', '{"judge":false}', '{"paid_fallback":false}', '{"credit_enrichment":false}']) {
    const x = await runScan(b)
    assert.equal(x.autopilot, 0, `no autopilot under ${b}`)
  }
})

test('weekly watches: the budget is saved on the watch and every weekly run job carries it; an unbudgeted watch is unchanged', () => {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateWatch(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const w1 = createWatch(db, 'A', 'dental practices in Toronto hiring', icp, '{"max_usd":0.25,"judge":false}').watch!
  const w2 = createWatch(db, 'A', 'dental practices in Ohio hiring', icp).watch!
  assert.equal(w1.run_budget, '{"max_usd":0.25,"judge":false}'); assert.equal(w2.run_budget, null)
  // due watches -> one job each; the budgeted watch's job carries the budget
  db.prepare('UPDATE watches SET next_run_at = 0').run()
  assert.equal(runDueWatches(db, 10).ran, 1, 'one scan at a time per user: the first due watch runs')
  const j = db.prepare('SELECT watch_id, run_budget FROM scan_jobs').all() as { watch_id: string; run_budget: string | null }[]
  assert.equal(j.length, 1); assert.equal(j[0].run_budget, j[0].watch_id === w1.id ? '{"max_usd":0.25,"judge":false}' : null)
  // an older database without the column is migrated in place
  const old = new Database(':memory:'); old.exec('CREATE TABLE watches (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, query TEXT NOT NULL, icp TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, next_run_at INTEGER NOT NULL, last_run_at INTEGER, paused_reason TEXT, created_at INTEGER NOT NULL DEFAULT 0)')
  migrateWatch(old); migrateWatch(old)
  assert.ok((old.prepare('PRAGMA table_info(watches)').all() as { name: string }[]).some(c => c.name === 'run_budget'))
})

test('run-budget.ts is bundled into the browser: it must not use Node-only globals (a Buffer reference crashed the whole leads page in the rendered check)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/scan/run-budget.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(src, /\bBuffer\b|\bprocess\./)
})
