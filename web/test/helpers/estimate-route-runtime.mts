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
import { periodOf } from '../../lib/llm/spend-pool.ts'
import { claimKeyedJob } from '../../lib/scan/runner.ts'

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

// ---- keyless trial accounts: a request refused with no run must not consume a trial attempt or budget ----
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' }
async function keyless(fn: (db: Database.Database, id: string) => Promise<void>) {
  const old = Object.fromEntries(Object.keys(TRIAL_ENV).map(k => [k, process.env[k]])); Object.assign(process.env, TRIAL_ENV)
  try {
    const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
    const id = `K${++n}`
    db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')").run(id, `${id}@gmail.com`)
    db.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)").run(`sub-${id}`, id)
    db.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'Acme', 'personal', ?, 1)").run(id, id) // as sign-in creates it
    setUser({ id, business_name: 'Acme', email: `${id}@gmail.com` })     // no API key: the shared trial funds this account
    await fn(db, id)
  } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const reservations = (db: Database.Database) => db.prepare('SELECT id, job_id FROM trial_reservations').all() as { id: string; job_id: string | null }[]

test('keyless: a stale estimate_ack returns 409 with NO job and NO reservation; repeated refusals never consume the 3 trial attempts; the retry with the right ack runs and links its one reservation', async () => {
  await keyless(async db => {
    const body = { query: Q, budget: { max_usd: 2, judge: false } }
    const e = await (await est(body)).json() as { estimate: { ack: string } }
    for (let i = 0; i < 5; i++) {
      const r = await scan({ ...body, estimate_ack: 'stale-ack' }); assert.equal(r.status, 409); assert.equal((await r.json() as { error: string }).error, 'estimate_changed')
      assert.equal(jobs(db).length, 0); assert.equal(reservations(db).length, 0, `refusal ${i + 1} reserved nothing`)
    }
    const ok = await scan({ ...body, estimate_ack: e.estimate.ack }); assert.equal(ok.status, 202)
    const rs = reservations(db); assert.equal(rs.length, 1); assert.equal(rs[0].job_id, jobs(db)[0].id)
  })
})

test('keyless: an over-budget request returns 402 over_budget with no job and no reservation; a corrected retry runs', async () => {
  await keyless(async db => {
    const bad = await scan({ query: Q, budget: { max_usd: 0.02 } }); assert.equal(bad.status, 402); assert.equal((await bad.json() as { error: string }).error, 'over_budget')
    assert.equal(jobs(db).length, 0); assert.equal(reservations(db).length, 0)
    assert.equal((await scan({ query: Q, budget: { max_usd: 1, judge: false } })).status, 202); assert.equal(reservations(db).length, 1)
  })
})

test('keyless: if creating the job fails AFTER the reservation, the reservation is released (the attempt and budget are given back); the retry then runs', async () => {
  await keyless(async db => {
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON scan_jobs BEGIN SELECT RAISE(ABORT, 'boom'); END")
    await assert.rejects(scan({ query: Q, budget: { max_usd: 1, judge: false } }))
    assert.equal(reservations(db).length, 0, 'the unlinked reservation was unwound'); assert.equal(jobs(db).length, 0)
    db.exec('DROP TRIGGER boom')
    assert.equal((await scan({ query: Q, budget: { max_usd: 1, judge: false } })).status, 202); assert.equal(reservations(db).length, 1)
  })
})

test('payer change: a trial confirmation is not accepted after the account adds its own key (409, no job); the fresh confirmation runs', async () => {
  await keyless(async (db, id) => {
    const body = { query: Q, budget: { max_usd: 2, judge: false } }
    const e = await (await est(body)).json() as { estimate: { ack: string; payer: string } }; assert.equal(e.estimate.payer, 'trial')
    saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')           // an own key appears after the person confirmed the trial estimate
    const r = await scan({ ...body, estimate_ack: e.estimate.ack }); const j = await r.json() as { error: string; estimate: { ack: string; payer: string } }
    assert.equal(r.status, 409); assert.equal(j.error, 'estimate_changed'); assert.equal(j.estimate.payer, 'you'); assert.notEqual(j.estimate.ack, e.estimate.ack)
    assert.equal(jobs(db).length, 0); assert.equal(reservations(db).length, 0)
    assert.equal((await scan({ ...body, estimate_ack: j.estimate.ack })).status, 202, 'the fresh confirmation runs, on the own key')
  })
})

test('reduced remaining room: reserving $1.50 of a $2 limit after the confirmation changes it (409, new warning, no job); the fresh confirmation runs', async () => {
  const db = setup(); as(db)
  const tenant = `E${n}`
  const body = { query: Q, budget: { max_usd: 2, judge: false } }
  const e = await (await est(body)).json() as { estimate: { ack: string; verdict: { warning: string | null }; cap: { reserved_usd: number } } }
  assert.equal(e.estimate.verdict.warning, null); assert.equal(e.estimate.cap.reserved_usd, 0)
  db.prepare('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 1.5, 0, 1, ?)').run(tenant, periodOf('day', Math.floor(Date.now() / 1000)), Math.floor(Date.now() / 1000))
  const r = await scan({ ...body, estimate_ack: e.estimate.ack }); const j = await r.json() as { error: string; estimate: { ack: string; verdict: { warning: string | null }; cap: { reserved_usd: number; remaining_usd: number } } }
  assert.equal(r.status, 409); assert.equal(j.error, 'estimate_changed'); assert.equal(j.estimate.cap.reserved_usd, 1.5); assert.equal(j.estimate.cap.remaining_usd, 0.5)
  assert.ok(j.estimate.verdict.warning, 'the reduced room raised a warning the person has not seen'); assert.equal(jobs(db).length, 0)
  assert.equal((await scan({ ...body, estimate_ack: j.estimate.ack })).status, 202)
})

test('unknown pool state: a pool read failure is NOT zero reserved - the estimate refuses to confirm and POST /api/scan returns 503 with no job; once readable it runs', async () => {
  const db = setup(); as(db)
  const body = { query: Q, budget: { max_usd: 2, judge: false } }
  db.exec('ALTER TABLE tenant_spend_pools RENAME TO tenant_spend_pools_x')   // the shared-pool read now fails
  const e = await (await est(body)).json() as { estimate: { ack: string; verdict: { ok: boolean; reason: string; message: string }; cap: { unknown: boolean } } }
  assert.equal(e.estimate.verdict.ok, false); assert.equal(e.estimate.verdict.reason, 'budget_unknown'); assert.equal(e.estimate.cap.unknown, true); assert.equal((e.estimate.cap as unknown as { remaining_usd: number | null }).remaining_usd, null, 'remaining is unknown, not 0')
  assert.doesNotMatch(e.estimate.verdict.message, /Within your limit/)
  const r = await scan(body); const j = await r.json() as { error: string }
  assert.equal(r.status, 503); assert.equal(j.error, 'budget_unknown'); assert.equal(jobs(db).length, 0)
  const r2 = await scan({ ...body, estimate_ack: e.estimate.ack }); assert.equal(r2.status, 503); assert.equal(jobs(db).length, 0)
  db.exec('ALTER TABLE tenant_spend_pools_x RENAME TO tenant_spend_pools')
  const ok = await (await est(body)).json() as { estimate: { ack: string; verdict: { ok: boolean }; cap: { unknown: boolean } } }
  assert.equal(ok.estimate.verdict.ok, true); assert.equal(ok.estimate.cap.unknown, false); assert.notEqual(ok.estimate.ack, e.estimate.ack)
  assert.equal((await scan({ ...body, estimate_ack: ok.estimate.ack })).status, 202)
})

test('monthly limit: with the owner month pool exhausted the estimate does not advertise room (402, no job); the tighter of day/month binds and the month is in the confirmation', async () => {
  const db = setup(); as(db)
  const tenant = `E${n}`, now = Math.floor(Date.now() / 1000)
  process.env.DAZL_OWNER_MONTH_MAX_USD_USERS = `${tenant}:3`
  try {
    const body = { query: Q, budget: { max_usd: 2, judge: false } }
    const e = await (await est(body)).json() as { estimate: { ack: string; cap: { remaining_usd: number; month_cap_usd: number } } }
    assert.equal(e.estimate.cap.month_cap_usd, 3); assert.equal(e.estimate.cap.remaining_usd, 2)   // day (2) is tighter than month (3)
    db.prepare('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 2.999, 0, 1, ?)').run(tenant, periodOf('month', now), now)
    const r = await scan({ ...body, estimate_ack: e.estimate.ack }); const j = await r.json() as { error: string; message: string; estimate: { cap: { remaining_usd: number } } }
    assert.equal(r.status, 402); assert.equal(j.error, 'over_budget'); assert.equal(j.estimate.cap.remaining_usd < 0.0011, true); assert.match(j.message, /monthly limit/); assert.equal(jobs(db).length, 0)
    const e2 = await (await est(body)).json() as { estimate: { ack: string; verdict: { ok: boolean; message: string } } }
    assert.equal(e2.estimate.verdict.ok, false); assert.doesNotMatch(e2.estimate.verdict.message, /Within your limit/); assert.notEqual(e2.estimate.ack, e.estimate.ack)
  } finally { delete process.env.DAZL_OWNER_MONTH_MAX_USD_USERS }
})

test('an unaccounted paid call (failed or stale pending marker): estimate blocked with the reason, POST /api/scan 409 and no job; a fresh marker (a call in flight) does not block', async () => {
  const db = setup(); as(db)
  const tenant = `E${n}`, now = Math.floor(Date.now() / 1000)
  const body = { query: Q, budget: { max_usd: 2, judge: false } }
  // In flight: the run would wait for it, as the pool does; not blocked.
  db.prepare("INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, 'p:aaaaaaaaaa', 0.01, 0, 0, ?)").run(tenant, now)
  const live = await (await est(body)).json() as { estimate: { verdict: { ok: boolean; reason: string | null } } }
  assert.deepEqual([live.estimate.verdict.ok, live.estimate.verdict.reason], [true, null])
  // Marked failed (updated_at 0): the pool refuses every reservation, and so does the estimate and the start.
  db.prepare("UPDATE tenant_spend_pools SET updated_at = 0 WHERE tenant_id = ? AND period = 'p:aaaaaaaaaa'").run(tenant)
  const e = await (await est(body)).json() as { estimate: { verdict: { ok: boolean; reason: string; message: string } } }
  assert.deepEqual([e.estimate.verdict.ok, e.estimate.verdict.reason], [false, 'accounting_unsettled'])
  assert.match(e.estimate.verdict.message, /could not be recorded/); assert.doesNotMatch(e.estimate.verdict.message, /Within your limit/)
  const r = await scan(body); const j = await r.json() as { error: string }
  assert.deepEqual([r.status, j.error], [409, 'accounting_unsettled']); assert.equal(jobs(db).length, 0)
  // Cleared by an operator: the reservation stays in the windows, the run can start.
  db.prepare("DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE 'p:%'").run(tenant)
  const ok = await (await est(body)).json() as { estimate: { ack: string; verdict: { ok: boolean } } }
  assert.equal(ok.estimate.verdict.ok, true)
  assert.equal((await scan({ ...body, estimate_ack: ok.estimate.ack })).status, 202)
})

// ---- no partial job: a failure at ANY step of starting a scan leaves no job a worker could claim, no consumed attempt, and a clean retry ----
const STEPS: [string, string][] = [
  ['linking the reservation', "CREATE TRIGGER boom BEFORE UPDATE ON trial_reservations BEGIN SELECT RAISE(ABORT, 'boom'); END"],
  ['creating the job', "CREATE TRIGGER boom BEFORE INSERT ON scan_jobs BEGIN SELECT RAISE(ABORT, 'boom'); END"],
  ['writing the estimate', "CREATE TRIGGER boom BEFORE UPDATE OF estimate ON scan_jobs BEGIN SELECT RAISE(ABORT, 'boom'); END"],
  ['marking the job trial-funded', "CREATE TRIGGER boom BEFORE UPDATE OF funded_by ON scan_jobs BEGIN SELECT RAISE(ABORT, 'boom'); END"],
  ['counting the trial scan', "CREATE TRIGGER boom BEFORE INSERT ON trial_scans BEGIN SELECT RAISE(ABORT, 'boom'); END"],
]
for (const [step, trigger] of STEPS) {
  test(`keyless: a failure while ${step} leaves no job (pending or otherwise), no reservation and no trial count; a background claim finds nothing; the retry runs with everything set`, async () => {
    await keyless(async db => {
      const body = { query: Q, budget: { max_usd: 1, judge: false } }
      db.exec(trigger)
      await assert.rejects(scan(body))
      assert.equal(jobs(db).length, 0, 'no partial job'); assert.equal(reservations(db).length, 0, 'the attempt and budget are given back')
      assert.equal((db.prepare('SELECT count(*) AS c FROM trial_scans').get() as { c: number }).c, 0, 'no trial count')
      assert.equal(claimKeyedJob(db), null, 'a background worker has nothing to claim')
      db.exec('DROP TRIGGER boom')
      const r = await scan(body); assert.equal(r.status, 202)
      const j = db.prepare('SELECT id, funded_by, estimate, status FROM scan_jobs').all() as { id: string; funded_by: string | null; estimate: string | null; status: string }[]
      assert.equal(j.length, 1); assert.equal(j[0].funded_by, 'trial'); assert.ok(j[0].estimate); assert.equal(j[0].status, 'pending')
      const rs = reservations(db); assert.equal(rs.length, 1); assert.equal(rs[0].job_id, j[0].id, 'the reservation is linked to the job that exists')
      assert.equal((db.prepare('SELECT count(*) AS c FROM trial_scans').get() as { c: number }).c, 1)
    })
  })
}

test('own-key account: a failure while writing the estimate leaves no job either (nothing to block a retry); the retry runs', async () => {
  const db = setup(); as(db)
  db.exec("CREATE TRIGGER boom BEFORE UPDATE OF estimate ON scan_jobs BEGIN SELECT RAISE(ABORT, 'boom'); END")
  await assert.rejects(scan({ query: Q, budget: { max_usd: 1, judge: false } })); assert.equal(jobs(db).length, 0); assert.equal(claimKeyedJob(db), null)
  db.exec('DROP TRIGGER boom'); assert.equal((await scan({ query: Q, budget: { max_usd: 1, judge: false } })).status, 202); assert.equal(jobs(db).length, 1)
})

test('OpenAI key under a spending limit: the estimate and POST /api/scan refuse BEFORE launch (422 model_unpriced, no job); no limit, or an Anthropic key, is unaffected', async () => {
  const db = setup(); const id = `E${++n}`
  saveKey(db, id, 'openai', 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); setUser({ id, business_name: 'Acme' })
  const saved = process.env.DAZL_OPENAI_MODEL; delete process.env.DAZL_OPENAI_MODEL
  try {
    const limited = { query: Q, budget: { max_usd: 2, judge: false } }
    const e = await (await est(limited)).json() as { estimate: { verdict: { ok: boolean; reason: string; message: string; change: string[] } } }
    assert.deepEqual([e.estimate.verdict.ok, e.estimate.verdict.reason], [false, 'model_unpriced'])
    assert.match(e.estimate.verdict.message, /no listed price/); assert.match(e.estimate.verdict.message, /Nothing was started or charged/)
    assert.ok(e.estimate.verdict.change.length >= 2)
    const r = await scan(limited); const j = await r.json() as { error: string; message: string }
    assert.deepEqual([r.status, j.error], [422, 'model_unpriced']); assert.equal(jobs(db).length, 0, 'no job')
    // Without a limit nothing is reserved, so nothing needs a price: not blocked.
    const free = await (await est({ query: Q })).json() as { estimate: { verdict: { ok: boolean; reason: string | null } } }
    assert.notEqual(free.estimate.verdict.reason, 'model_unpriced')
    // An Anthropic key under the same limit is not blocked by this check.
    const a = `E${++n}`; saveKey(db, a, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); setUser({ id: a, business_name: 'Acme' })
    const ok = await (await est(limited)).json() as { estimate: { verdict: { reason: string | null } } }
    assert.notEqual(ok.estimate.verdict.reason, 'model_unpriced')
  } finally { if (saved === undefined) delete process.env.DAZL_OPENAI_MODEL; else process.env.DAZL_OPENAI_MODEL = saved }
})

// ---- #851: the estimate (and so the confirmation and the start gate) prices the model the run will really call ----
import { estimateForBody } from '../../lib/scan/estimate-request.ts'
import { sqliteDb } from '../../lib/db/client.ts'
type Est = { estimate: { ack: string; payer: string; rows: { id: string; kind: string; unit_usd: string; usd: { min: number; max: number } | null }[]; total: { min: number; max: number }; unpriced: string[]; assumptions: string[]; verdict: { ok: boolean; reason: string | null; message: string; change: string[] } } }
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const modelRowsOf = (e: Est) => e.estimate.rows.filter(r => r.kind === 'model')

test('#851 OpenAI key, no limit: the route shows gpt-4.1 at its own listed price (not claude-sonnet-4-5), and the started job keeps that estimate', async () => {
  await withEnv({ DAZL_OPENAI_MODEL: undefined }, async () => {
    const db = setup(); const id = `E${++n}`; saveKey(db, id, 'openai', 'sk-pro...AAAA'); setUser({ id, business_name: 'Acme' })
    const r = await est({ query: Q }); const e = await r.json() as Est
    assert.equal(r.status, 200)
    assert.ok(modelRowsOf(e).every(x => x.unit_usd === '$3.50 in / $14.00 out per 1M tokens (gpt-4.1)'), JSON.stringify(modelRowsOf(e).map(x => x.unit_usd)))
    assert.match(e.estimate.assumptions[0], /^Model: gpt-4\.1\./); assert.equal(e.estimate.verdict.ok, true)
    const a = `E${++n}`; saveKey(db, a, 'anthropic', 'sk-ant...AAAA'); setUser({ id: a, business_name: 'Acme' })
    const sonnet = await (await est({ query: Q })).json() as Est
    assert.ok(modelRowsOf(sonnet).every(x => /\(claude-sonnet-4-5\)$/.test(x.unit_usd)))
    assert.notDeepEqual(e.estimate.total, sonnet.estimate.total); assert.notEqual(e.estimate.ack, sonnet.estimate.ack)
    setUser({ id, business_name: 'Acme' })
    const ok = await scan({ query: Q, estimate_ack: e.estimate.ack }); assert.equal(ok.status, 202)
    const saved = JSON.parse(jobs(db)[0].estimate!) as { rows: { kind: string; unit_usd: string }[]; ack: string }
    assert.equal(saved.ack, e.estimate.ack); assert.ok(saved.rows.filter(x => x.kind === 'model').every(x => /\(gpt-4\.1\)$/.test(x.unit_usd)))
  })
})

test('#851 a changed key model after confirmation is a changed estimate: 409 estimate_changed naming the new model, no job; the fresh confirmation runs', async () => {
  await withEnv({ DAZL_OPENAI_MODEL: undefined }, async () => {
    const db = setup(); const id = `E${++n}`; saveKey(db, id, 'openai', 'sk-pro...AAAA'); setUser({ id, business_name: 'Acme' })
    const e = await (await est({ query: Q })).json() as Est
    process.env.DAZL_OPENAI_MODEL = 'gpt-4.1-2025-04-14'
    const r = await scan({ query: Q, estimate_ack: e.estimate.ack }); const j = await r.json() as { error: string } & Est
    assert.deepEqual([r.status, j.error], [409, 'estimate_changed']); assert.notEqual(j.estimate.ack, e.estimate.ack)
    assert.ok(modelRowsOf(j).every(x => /\(gpt-4\.1-2025-04-14\)$/.test(x.unit_usd)), 'the re-shown estimate names the model that will run')
    assert.equal(jobs(db).length, 0)
    assert.equal((await scan({ query: Q, estimate_ack: j.estimate.ack })).status, 202)
  })
})

test('#851 an Anthropic key on a model the limit guard cannot price (dated id): refused before launch under a limit (422, no job, no Anthropic-key advice); no limit runs', async () => {
  await withEnv({ DAZL_ANTHROPIC_MODEL: 'claude-sonnet-4-5-20250929' }, async () => {
    const db = setup(); as(db)
    const limited = { query: Q, budget: { max_usd: 2, judge: false } }
    const e = await (await est(limited)).json() as Est
    assert.deepEqual([e.estimate.verdict.ok, e.estimate.verdict.reason], [false, 'model_unpriced'])
    assert.match(e.estimate.verdict.message, /Your key's model \(claude-sonnet-4-5-20250929\) has no listed price/)
    assert.ok(!e.estimate.verdict.change.some(c => /Anthropic key/.test(c)), 'the Anthropic key is this model: not offered as the fix')
    assert.ok(modelRowsOf(e).every(x => x.usd !== null), 'the rows are still priced as the scan cap prices the alias')
    const r = await scan(limited); assert.deepEqual([r.status, (await r.json() as { error: string }).error], [422, 'model_unpriced']); assert.equal(jobs(db).length, 0)
    assert.equal((await scan({ query: Q })).status, 202, 'without a limit nothing is reserved against the limit guard')
  })
})

test('#851 keyless trial on an unpriceable operator model: refused before any reservation (422 model_unpriced, no job, no reservation, no trial count); the default model runs', async () => {
  await keyless(async db => {
    await withEnv({ DAZL_ANTHROPIC_MODEL: 'claude-opus-unlisted' }, async () => {
      const e = await (await est({ query: Q })).json() as Est
      assert.equal(e.estimate.payer, 'trial'); assert.deepEqual([e.estimate.verdict.ok, e.estimate.verdict.reason], [false, 'model_unpriced'])
      assert.match(e.estimate.verdict.message, /^The free trial's model \(claude-opus-unlisted\)/)
      assert.ok(modelRowsOf(e).every(x => x.usd === null && /claude-opus-unlisted: no listed price/.test(x.unit_usd)))
      const r = await scan({ query: Q }); assert.deepEqual([r.status, (await r.json() as { error: string }).error], [422, 'model_unpriced'])
      assert.equal(jobs(db).length, 0); assert.equal(reservations(db).length, 0)
      assert.equal((db.prepare('SELECT count(*) AS c FROM trial_scans').get() as { c: number }).c, 0)
    })
    await withEnv({ DAZL_ANTHROPIC_MODEL: undefined }, async () => {
      const ok = await (await est({ query: Q })).json() as Est
      assert.ok(modelRowsOf(ok).every(x => /\(claude-sonnet-4-5\)$/.test(x.unit_usd))); assert.equal(ok.estimate.verdict.ok, true)
      assert.equal((await scan({ query: Q, estimate_ack: ok.estimate.ack })).status, 202)
    })
  })
})

test('#851 an own key whose model cannot be read (null, blank, wrong type) is UNKNOWN, never the default: unpriced rows; refused under a limit', async () => {
  const raw = setup(); const db = sqliteDb(raw)
  for (const model of [null, undefined, '', '  ', 7 as unknown as string]) {
    const free = await estimateForBody({ query: Q }, { db, tenantId: 'T851', hasOwnKey: true, model, enrichmentVendors: [] })
    assert.ok(free.ok); assert.ok(free.estimate.rows.filter(x => x.kind === 'model').every(x => x.usd === null && /^unknown model/.test(x.unit_usd)), String(model))
    assert.equal(free.estimate.verdict.reason, null)
    const lim = await estimateForBody({ query: Q, budget: { max_usd: 2 } }, { db, tenantId: 'T851', hasOwnKey: true, model, enrichmentVendors: [] })
    assert.ok(lim.ok); assert.deepEqual([lim.estimate.verdict.ok, lim.estimate.verdict.reason], [false, 'model_unpriced']); assert.match(lim.estimate.verdict.message, /could not be read/)
  }
  // Trial: the own-key model passed in is ignored (another account's / stale value cannot price a trial run).
  const t = await estimateForBody({ query: Q }, { db, tenantId: 'T851', hasOwnKey: false, model: 'gpt-4.1', enrichmentVendors: [] })
  assert.ok(t.ok); assert.ok(t.estimate.rows.filter(x => x.kind === 'model').every(x => /\(claude-sonnet-4-5\)$/.test(x.unit_usd)))
})
