import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { POST } from '../../app/api/scan/route.ts'
import { POST as WATCH_POST } from '../../app/api/watch/route.ts'
import { migrateWatch } from '../../lib/watch.ts'

// Real POST /api/scan handler, in-memory db, network fenced, runner never started (after() is captured and not flushed).
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db)
  setScanDb(db)
  return db
}
// The route rate-limits per user (10 scans per hour, in process), so every request comes from a fresh user with a key.
function as(db: Database.Database) {
  const id = `U${++n}`; saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); setUser({ id, business_name: 'Acme' })
}
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.0.0.${++n}` }, body: JSON.stringify(body) }))
const rows = (db: Database.Database) => db.prepare('SELECT id, run_budget, status FROM scan_jobs').all() as { id: string; run_budget: string | null; status: string }[]
const Q = 'Independent dental practices hiring a receptionist in New York in the past 90 days'

test('no budget: today\'s behaviour - 202 with only job_id, run_budget null', async () => {
  const db = setup()
  as(db); const r = await post({ query: Q }); const j = await r.json() as Record<string, unknown>
  assert.equal(r.status, 202); assert.deepEqual(Object.keys(j), ['job_id'])
  assert.deepEqual(rows(db).map(x => x.run_budget), [null])
})

test('valid budget: persisted with the job in the same insert, and answered with the exact paid-surface disclosure', async () => {
  const db = setup()
  as(db); const r = await post({ query: Q, budget: { max_usd: 0.5, judge: false } }); const j = await r.json() as { job_id: string; budget: { bounded: boolean; max_usd: number; ceiling: string; surfaces: { surface: string; status: string }[]; limits: string[] } }
  assert.equal(r.status, 202)
  assert.deepEqual(JSON.parse(rows(db)[0].run_budget!), { max_usd: 0.5, judge: false })
  assert.equal((j.budget as unknown as { scope: string }).scope, 'partial'); assert.ok((j.budget as unknown as { excluded_paths: string[] }).excluded_paths.some(x => /Profile generation/.test(x)) && (j.budget as unknown as { excluded_paths: string[] }).excluded_paths.some(x => /TinyFish/.test(x)) && (j.budget as unknown as { excluded_paths: string[] }).excluded_paths.some(x => /Autopilot/.test(x)))
  assert.equal(j.budget.bounded, true); assert.equal(j.budget.max_usd, 0.5); assert.match(j.budget.ceiling, /PARTIAL budget, not a whole-scan dollar ceiling/); assert.match(j.budget.ceiling, /Not a bill and not a vendor-enforced ceiling/)
  const st = Object.fromEntries(j.budget.surfaces.map(s => [s.surface, s.status]))
  assert.deepEqual(st, { profile_generation: 'not_covered', search_query_writing: 'allowed', extraction: 'allowed', scoring: 'allowed', grounding: 'refused', buyer_fit: 'allowed', judge: 'off', fallback_research: 'refused', credit_enrichment: 'off', search_and_fetch: 'not_covered', autopilot: 'off' })
  assert.ok(j.budget.limits.some(l => /budget stop, not zero results/.test(l)) && j.budget.limits.some(l => /resets when the process restarts/.test(l)))
})

test('invalid budgets are rejected BEFORE anything is queued: 400 invalid_budget, no job row', async () => {
  const db = setup()
  for (const bad of [null, [], 'x', {}, { max_usd: 0 }, { max_usd: -1 }, { max_usd: '5' }, { max_usd: 1e9 }, { max_usd: Infinity }, { judge: true }, { paid_fallback: 'false' }, { nope: false }, { max_usd: 1, extra: 1 }]) {
    as(db); const r = await post({ query: Q, budget: bad }); const j = await r.json() as { error: string; detail: string }
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(j.error, 'invalid_budget'); assert.ok(j.detail.length > 0)
  }
  assert.equal(rows(db).length, 0, 'nothing was created for any rejected budget')
})

test('a legacy (non-query) request also persists a supplied budget', async () => {
  const db = setup()
  as(db); const r = await post({ business_name: 'Acme', industry: 'roofing', location: 'Toronto', budget: { paid_fallback: false } })
  assert.equal(r.status, 202); assert.deepEqual(JSON.parse(rows(db)[0].run_budget!), { paid_fallback: false })
})

const ICP_JSON = { summary: 'Dental practices', who: ['Practice owner'], industries: [], sizes: [], where: ['Toronto'], signals: [], exclude: [] }
const wpost = (body: unknown) => WATCH_POST(new NextRequest('http://localhost/api/watch', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify(body) }))
test('POST /api/watch: a supplied budget is validated like the scan route and saved on the watch; none = unbounded as before', async () => {
  const db = setup(); migrateWatch(db)
  const wrow = () => db.prepare('SELECT run_budget FROM watches').all() as { run_budget: string | null }[]
  for (const bad of [null, {}, { max_usd: -1 }, { judge: true }, { nope: false }]) {
    as(db); const r = await wpost({ query: 'dental practices in Toronto hiring', icp: ICP_JSON, budget: bad }); const j = await r.json() as { error: string }
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(j.error, 'invalid_budget')
  }
  assert.equal(wrow().length, 0, 'no watch is created for a rejected budget')
  as(db); assert.equal((await wpost({ query: 'dental practices in Toronto hiring', icp: ICP_JSON, budget: { max_usd: 0.25, judge: false } })).status, 200)
  as(db); assert.equal((await wpost({ query: 'dental practices in Ohio hiring', icp: ICP_JSON })).status, 200)
  assert.deepEqual(wrow().map(w => w.run_budget === null ? null : JSON.parse(w.run_budget)), [{ max_usd: 0.25, judge: false }, null])
})
