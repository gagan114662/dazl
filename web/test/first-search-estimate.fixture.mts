// Feature-specific real-route fixture. Uses the existing tenant and no-network seams.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './helpers/tenant-route-db.ts'
import { POST as SCAN } from '../app/api/scan/route.ts'
import { GET as STATUS } from '../app/api/scan/status/route.ts'
import { PINNED_FIRST5_CLAUDE_ONLY_MODE } from '../lib/scan/qa-provider-policy.ts'
import { writeModelCalls } from '../lib/scan/model-usage.ts'
import { POST as ESTIMATE } from '../app/api/scan/estimate/route.ts'


process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.1.0.${++n}` }, body: JSON.stringify(body) })
const est = (body: unknown) => ESTIMATE(req('/api/scan/estimate', body))
const scan = (body: unknown) => SCAN(req('/api/scan', body))
const jobs = (db: Database.Database) => db.prepare('SELECT id, estimate FROM scan_jobs').all() as { id: string; estimate: string | null }[]
const Q = 'Independent dental practices hiring a receptionist in New York in the past 90 days'

import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
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

test('first-run wizard: the exact first5 profile and decision payload can be estimated and acknowledged without paid calls before admission', async () => {
  await keyless(async (db, uid) => {
    const icp = { summary: 'Clinic buyers', who: ['clinic managers'], industries: [], sizes: [], where: ['New York, NY'], signals: [], exclude: [],
      research: { v: 1, site: 'seller.example', offers: [{ i: 'booking', n: 'Booking' }], hyps: [{ i: 'booking:persona:1', o: 'booking', k: 'persona', t: 'clinic managers', s: 'reviewed', u: null, q: null, at: null }], q: null, ans: null } }
    const body = { query: Q, icp, mode: 'first5', research_decisions: [{ offer: 'booking', hypothesis: 'booking:persona:1', action: 'confirm' }] }
    const r = await est(body); assert.equal(r.status, 200)
    const { estimate } = await r.json() as { estimate: { ack: string; payer: string; trial_scan_cap_usd: number; verdict: { ok: boolean } } }
    assert.deepEqual([estimate.payer, estimate.trial_scan_cap_usd, estimate.verdict.ok], ['trial', 0.3, true])
    assert.equal(jobs(db).length, 0); assert.equal(reservations(db).length, 0)
    const accepted = await scan({ ...body, estimate_ack: estimate.ack })
    assert.equal(accepted.status, 202, await accepted.clone().text())
    const job = jobs(db)[0]
    assert.equal(JSON.parse(job.estimate!).ack, estimate.ack)
    assert.equal(JSON.parse(job.estimate!).trial_scan_cap_usd, 0.3, 'saved quote retains its trial cap')
    assert.equal(reservations(db)[0].job_id, job.id)
    assert.deepEqual(db.prepare('SELECT job_id, action, text FROM seller_decisions').get(), { job_id: job.id, action: 'confirm', text: 'clinic managers' })
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job.id)
    db.prepare("UPDATE scan_jobs SET status = 'done', finished_at = unixepoch() WHERE id = ?").run(job.id)
    writeModelCalls(db, uid, job.id, 1, [{ stage: 'extraction', method: 'complete', model_requested: 'claude-sonnet-4-5', model_served: 'claude-sonnet-4-5', input_tokens: 40_000, output_tokens: 7_000, outcome: 'ok', max_tokens: 4000, prompt_chars: 100 }])
    const result = await STATUS(new NextRequest(`http://localhost/api/scan/status?job_id=${job.id}&passive=1`, { headers: { host: 'localhost' } }))
    const { cost } = await result.json() as { cost: { estimate: { total: { max: number } }; actual: { model_usd: number; summary: string } } }
    assert.ok(cost.estimate.total.max <= 0.3)
    assert.ok(Math.abs(cost.actual.model_usd - 0.225) < 1e-9, 'recorded usage is not a projection or a charge')
  })
})

test('strict first play uses the same mode for the quote and acknowledgement and never falls back', async () => {
  await keyless(async db => {
    const body = { query: Q, mode: PINNED_FIRST5_CLAUDE_ONLY_MODE }
    const quote = await est(body)
    assert.equal(quote.status, 200)
    const { estimate } = await quote.json() as { estimate: { ack: string; rows: { provider: string }[] } }
    assert.equal(estimate.rows.some(r => r.provider === 'TinyFish'), false)
    assert.equal(jobs(db).length, 0)
    assert.equal(reservations(db).length, 0)
    const stale = await scan({ ...body, estimate_ack: 'stale' })
    assert.equal(stale.status, 409)
    assert.equal(jobs(db).length, 0)
    assert.equal(reservations(db).length, 0)
    const ok = await scan({ ...body, estimate_ack: estimate.ack })
    assert.equal(ok.status, 202)
    const admitted = await ok.json()
    assert.equal(admitted.provider_policy, 'claude_only_v1')
    assert.equal(admitted.execution, 'local_once_v1')
    assert.equal(JSON.parse(jobs(db)[0].estimate!).ack, estimate.ack)
  })
})
