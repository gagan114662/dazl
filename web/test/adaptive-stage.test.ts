// #381 wired: one bounded adaptive round after the first batch. Injected search/verify; invented profile; both engines for the persisted rounds. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { runAdaptiveRound, type AdaptiveInput } from '../lib/scan/adaptive-stage.ts'
import { loadRounds, queryKey } from '../lib/scan/discovery-rounds.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'

const NOW = new Date('2026-10-20T12:00:00Z')
const ICP = { signals: ['opened a second dental office in Brooklyn', 'hiring a front desk receptionist in Queens'], where: ['New York City'] }
const F0 = { candidates: 2, verified: 0, fit_ok: 0, timed: 0, identified: 0, actionable: 0 }
async function job(db: Db, id = 'job1', tenant = 'A') {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')", [id, tenant])
}
const input = (db: Db, o: Partial<AdaptiveInput> = {}): AdaptiveInput => ({ db, tenantId: 'A', jobId: 'job1', query: 'dental practices opening a new location in New York City', icp: ICP, funnel: F0, source: 'search:news', spent: { searches: 0, pages: 0, ms: 0 }, now: NOW, search: async () => ({ found: 2 }), verify: async () => 2, ...o })

bothEngines('a shortfall triggers one round: new queries, found candidates verified through the caller, each query recorded', async ({ db }) => {
  await job(db); const asked: string[][] = []
  const r = await runAdaptiveRound(input(db, { search: async q => { asked.push(q); return { found: 2 } }, verify: async () => 3 }))
  assert.equal(r.ran, true); assert.equal(r.decision.action, 'search'); assert.equal(r.diagnosis, 'extraction'); assert.equal(r.found, 2); assert.deepEqual([r.actionable_before, r.actionable_after], [0, 3])
  assert.equal(asked.length, 1); assert.ok(asked[0].length >= 1 && asked[0].length <= 3); assert.ok(asked[0].every(q => /New York/i.test(q)), 'geography is kept, never widened')
  const rounds = await loadRounds(db, 'A', 'job1'); assert.equal(rounds.length, asked[0].length); assert.ok(rounds.every(x => x.round === 1 && x.outcome === 'ok' && x.source === 'search:news' && x.actionable_after === 3))
})

bothEngines('a query that failed or came back empty is recorded and never asked again (this job and this tenant\'s later jobs)', async ({ db }) => {
  await job(db); await job(db, 'job2')
  const first: string[] = []; await runAdaptiveRound(input(db, { search: async q => { first.push(...q); return { found: 0 } } }))
  assert.ok((await loadRounds(db, 'A', 'job1')).every(x => x.outcome === 'empty'))
  const second: string[] = []; const r2 = await runAdaptiveRound(input(db, { jobId: 'job2', search: async q => { second.push(...q); return { found: 0 } } }))
  assert.ok(second.every(q => !first.map(queryKey).includes(queryKey(q))), 'no repeat of an empty query'); assert.ok(r2.ran === false ? r2.decision.action === 'stop' : true)
  await job(db, 'job3')
  await runAdaptiveRound(input(db, { jobId: 'job3', search: async () => { throw new Error('news down') } })); assert.ok((await loadRounds(db, 'A', 'job3')).every(x => x.outcome === 'failed'))
})

bothEngines('stops, with its reason, when there is nothing to do: target met, limits reached, or the loss is after discovery', async ({ db }) => {
  await job(db)
  const met = await runAdaptiveRound(input(db, { funnel: { ...F0, candidates: 8, verified: 6, fit_ok: 6, timed: 6, identified: 6, actionable: 6 } })); assert.equal(met.ran, false); assert.deepEqual(met.decision, { action: 'stop', reason: 'target_met', detail: met.decision.action === 'stop' ? met.decision.detail : '' })
  const budget = await runAdaptiveRound(input(db, { spent: { searches: 8, pages: 0, ms: 0 } })); assert.equal(budget.decision.action === 'stop' && budget.decision.reason, 'budget_exhausted')
  const slow = await runAdaptiveRound(input(db, { spent: { searches: 0, pages: 0, ms: 999_999 } })); assert.equal(slow.decision.action === 'stop' && slow.decision.reason, 'time_exhausted')
  const ident = await runAdaptiveRound(input(db, { funnel: { candidates: 4, verified: 4, fit_ok: 4, timed: 4, identified: 0, actionable: 0 } })); assert.equal(ident.decision.action, 'enrich'); assert.equal(ident.ran, false, 'more searching would not fix an identity gap')
  assert.equal((await loadRounds(db, 'A', 'job1')).length, 0, 'a stop records no round')
})

bothEngines('tenant separation: another tenant\'s job and rounds are invisible', async ({ db }) => {
  await job(db, 'jobA', 'A'); await job(db, 'jobB', 'B')
  await runAdaptiveRound(input(db, { jobId: 'jobA', search: async () => ({ found: 1 }), verify: async () => 1 }))
  assert.equal((await loadRounds(db, 'B', 'jobA')).length, 0); assert.ok((await loadRounds(db, 'A', 'jobA')).length > 0)
})

test('a stop/timeout error from the search propagates (the scan stops); other errors are a failed round', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw); await job(db)
  await assert.rejects(runAdaptiveRound(input(db, { search: async () => { throw new Error('scan_stopped') } })), /scan_stopped/)
})

// ---- through the real runJob (stubbed news, pages and model; invented company) ----
import { runFixture, daysAgo, type Cand } from './helpers/acceptance-harness.ts'
import { runReportFor } from '../lib/scan/run-report.ts'
import type { SafeGet } from '../lib/sources/types.ts'
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const RICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding round', 'raised a seed round from investors'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const PRESS = 'https://sifted.example/clera-raises-seed', FUND = 'Clera, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const filler = ' More about the company, its product and its people.'.repeat(10)
const cand: Cand = { company: 'Clera', signal: 'raised a seed round', source_url: PRESS, excerpt: FUND, event_date: daysAgo(10) }
const gdelt = (urls: string[]) => JSON.stringify({ articles: urls.map(u => ({ url: u, title: 'Clera raises seed round', seendate: '20261016T100000Z' })) })
const BLOG = 'https://clera.example/blog/seed-round'
const OLD = 'Clera, a London B2B SaaS startup, raised a 3m GBP seed round in 2019'
const weak: Cand = { company: 'Clera', signal: 'raised a seed round', source_url: BLOG, excerpt: OLD, event_date: null }   // a real quote about an OLD event: held as stale, not recoverable by the blocked-page fallback
async function scan(adaptive: boolean) {
  const calls: string[] = []; let extractions = 0
  const newsHttp: SafeGet = async url => { calls.push(url); return { status: 200, body: gdelt([PRESS]) } }
  const saved = process.env.ADAPTIVE_DISCOVERY; if (adaptive) process.env.ADAPTIVE_DISCOVERY = '1'; else delete process.env.ADAPTIVE_DISCOVERY
  try {
    const x = await runFixture({ request: REQUEST, modelIcp: RICP, modelQueries: ['london saas startup seed round'], hits: [{ url: BLOG, title: 'Clera raises seed', snippet: FUND, date: daysAgo(10) }],
      tfPages: { [BLOG]: { title: 'Clera', text: `${OLD}.${filler}` } }, own: { [BLOG]: { title: 'Clera', text: `${OLD}.${filler}` }, [PRESS]: { title: 'Clera raises seed round', text: `On ${daysAgo(10)}, ${FUND}.${filler}` } },
      extraction: [], extractionFn: () => (++extractions === 1 ? [weak] : [cand]), deps: { newsHttp } })
    const jobId = (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
    return { x, jobId, calls, lead: x.db.prepare("SELECT review_reason, confidence FROM leads WHERE company = 'Clera' ORDER BY review_reason IS NOT NULL LIMIT 1").get() as { review_reason: string | null; confidence: number | null } | undefined }
  } finally { if (saved === undefined) delete process.env.ADAPTIVE_DISCOVERY; else process.env.ADAPTIVE_DISCOVERY = saved }
}
test('through the real scan, ADAPTIVE_DISCOVERY=1: a first batch with nothing gets one planned round that finds and verifies the lead; the rounds and the report say so', async () => {
  const r = await scan(true)
  assert.ok(r.lead && r.lead.review_reason === null && r.lead.confidence !== null, JSON.stringify(r.lead))
  const rounds = r.x.db.prepare('SELECT round, source, outcome FROM discovery_rounds WHERE job_id = ?').all(r.jobId) as { round: number; source: string; outcome: string }[]
  assert.ok(rounds.length >= 1 && rounds.every(x => x.round === 1 && x.source === 'search:news' && x.outcome === 'ok'), JSON.stringify(rounds))
  const rep = (runReportFor(r.x.db, 'A', r.jobId) as { adaptive?: { ran: boolean; found: number; actionable_after: number } }[]).findLast(x => x.adaptive)?.adaptive
  assert.ok(rep && rep.ran && rep.found >= 1 && rep.actionable_after >= 1, JSON.stringify(rep)); assert.ok(r.calls.length >= 2)
})
test('through the real scan, default (flag off): no adaptive round, no extra search, nothing recorded', async () => {
  const r = await scan(false)
  assert.equal((r.x.db.prepare('SELECT COUNT(*) n FROM discovery_rounds').get() as { n: number }).n, 0); assert.equal(r.lead?.review_reason, 'event_date_stale', 'the first-batch candidate stays held'); assert.equal(r.calls.length, 1, 'only the existing recovery search; the adaptive round adds none')
})
