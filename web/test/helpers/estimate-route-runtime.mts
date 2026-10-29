import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateTrial } from '../../lib/scan/trial.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { POST as SCAN } from '../../app/api/scan/route.ts'
import { GET as STATUS } from '../../app/api/scan/status/route.ts'
import { migrateModelUsage, writeModelCalls } from '../../lib/scan/model-usage.ts'
import { POST as ESTIMATE } from '../../app/api/scan/estimate/route.ts'

// Real POST /api/scan/estimate and POST /api/scan handlers, in-memory db, network fenced, runner never started.
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
function setup() { const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migratePlatform(db); migrateTrial(db); migrateModelUsage(db); setScanDb(db); return db }
function as(db: Database.Database) { const id = `E${++n}`; saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); setUser({ id, business_name: 'Acme' }) }
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.1.0.${++n}` }, body: JSON.stringify(body) })
const est = (body: unknown) => ESTIMATE(req('/api/scan/estimate', body))
const scan = (body: unknown) => SCAN(req('/api/scan', body))
const jobs = (db: Database.Database) => db.prepare('SELECT id, estimate FROM scan_jobs').all() as { id: string; estimate: string | null }[]
const Q = 'Independent dental practices hiring a receptionist in New York in the past 90 days'

test('estimate: a menu of providers with unit prices and a projected range; it queues nothing and counts nothing', async () => {
  const db = setup(); as(db)
  const r = await est({ query: Q }); const j = await r.json() as { estimate: { rows: { id: string; unit_usd: string; usd: { min: number; max: number } | null }[]; total: { min: number; max: number }; verdict: { ok: boolean }; assumptions: string[]; ack: string } }
  assert.equal(r.status, 200)
  const ids = j.estimate.rows.map(x => x.id)
  for (const id of ['search_query_writing', 'extraction', 'scoring', 'judge', 'fallback_research', 'tinyfish_search', 'tinyfish_fetch']) assert.ok(ids.includes(id), id)
  assert.ok(j.estimate.rows.every(x => x.unit_usd.length > 0), 'every row states its unit price')
  assert.ok(j.estimate.total.min > 0 && j.estimate.total.max > j.estimate.total.min); assert.equal(j.estimate.verdict.ok, true)
  assert.ok(j.estimate.assumptions.length >= 3 && /not a quote or a bill/.test(j.estimate.assumptions.join(' ')))
  assert.equal(jobs(db).length, 0, 'an estimate creates no job')
  assert.equal((db.prepare('SELECT count(*) AS c FROM trial_scans').get() as { c: number }).c, 0)
})

test('estimate: invalid budget and unknown mode are refused the way /api/scan refuses them', async () => {
  const db = setup(); as(db)
  assert.equal((await est({ query: Q, budget: { max_usd: -1 } })).status, 400)
  as(db); assert.equal((await est({ query: Q, mode: 'nope' })).status, 400)
  as(db); assert.equal((await est({ query: Q, mode: 'first5', budget: { max_usd: 1 } })).status, 400)
})

test('over the limit: estimate says blocked with what to change, and POST /api/scan refuses with 402 and creates nothing', async () => {
  const db = setup(); as(db)
  const e = await (await est({ query: Q, budget: { max_usd: 0.02 } })).json() as { estimate: { verdict: { ok: boolean; reason: string; message: string; change: string[] }; cap: { max_usd: number; remaining_usd: number } } }
  assert.equal(e.estimate.verdict.ok, false); assert.equal(e.estimate.verdict.reason, 'over_budget')
  assert.match(e.estimate.verdict.message, /Blocked/); assert.ok(e.estimate.verdict.change.some(c => /Raise the dollar limit/.test(c)))
  assert.deepEqual([e.estimate.cap.max_usd, e.estimate.cap.remaining_usd], [0.02, 0.02])
  as(db); const r = await scan({ query: Q, budget: { max_usd: 0.02 } }); const j = await r.json() as { error: string; change: string[] }
  assert.equal(r.status, 402); assert.equal(j.error, 'over_budget'); assert.ok(j.change.length > 0)
  assert.equal(jobs(db).length, 0, 'a blocked run creates no job')
})

test('confirmed run: the matching ack starts the scan and keeps the estimate with the job; a stale ack is returned for re-confirmation and starts nothing', async () => {
  const db = setup(); as(db)
  const body = { query: Q, budget: { max_usd: 2, judge: false } }
  const e = await (await est(body)).json() as { estimate: { ack: string; total: { min: number; max: number } } }
  const stale = await scan({ ...body, estimate_ack: 'stale-ack' }); const sj = await stale.json() as { error: string; estimate: { ack: string } }
  assert.equal(stale.status, 409); assert.equal(sj.error, 'estimate_changed'); assert.equal(sj.estimate.ack, e.estimate.ack); assert.equal(jobs(db).length, 0)
  const ok = await scan({ ...body, estimate_ack: e.estimate.ack }); assert.equal(ok.status, 202)
  const saved = JSON.parse(jobs(db)[0].estimate!) as { total: { min: number; max: number }; ack: string }
  assert.deepEqual(saved.total, e.estimate.total); assert.equal(saved.ack, e.estimate.ack)
})

test('an estimate does not change which runs are allowed: a normal budgeted run still starts without an ack', async () => {
  const db = setup(); as(db)
  assert.equal((await scan({ query: Q, budget: { max_usd: 0.5, judge: false } })).status, 202)
})

test('after the run: the status shows the confirmed estimate beside the actual from the tokens the provider reported; a scan without an estimate shows none', async () => {
  const db = setup(); as(db)
  const r = await scan({ query: Q, budget: { max_usd: 2 } }); const { job_id } = await r.json() as { job_id: string }
  const uid = (db.prepare('SELECT user_id FROM scan_jobs WHERE id = ?').get(job_id) as { user_id: string }).user_id
  const get = async () => (await STATUS(new NextRequest(`http://localhost/api/scan/status?job_id=${job_id}&passive=1`, { headers: { host: 'localhost' } }))).json() as Promise<{ cost: { estimate: { total: { min: number; max: number } }; actual: { model_usd: number | null; within: string; summary: string } | null } | null }>
  const running = await get()
  assert.ok(running.cost && running.cost.actual === null, 'no actual while the scan is still pending')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job_id)
  db.prepare("UPDATE scan_jobs SET status = 'done', finished_at = unixepoch() WHERE id = ?").run(job_id)
  writeModelCalls(db, uid, job_id, 1, [{ stage: 'extraction', method: 'complete', model_requested: 'claude-sonnet-4-5', model_served: 'claude-sonnet-4-5', input_tokens: 40_000, output_tokens: 7_000, outcome: 'ok', max_tokens: 4000, prompt_chars: 100 }])
  const done = await get()
  assert.ok(done.cost!.actual); assert.ok(Math.abs(done.cost!.actual!.model_usd! - (40_000 * 3 + 7_000 * 15) / 1e6) < 1e-9)
  assert.match(done.cost!.actual!.summary, /Not an invoice/)
  db.prepare('UPDATE scan_jobs SET estimate = NULL WHERE id = ?').run(job_id)
  assert.equal((await get()).cost, null)
})
