import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createQueryJob } from '../../lib/scan/store.ts'
import { POST } from '../../app/api/scan/route.ts'

// #913 acceptance, funded-trial path: the real POST /api/scan handler, throwaway in-memory store, network fenced, after() captured and
// never flushed (no runner, no provider call). The trial wallet is synthetic fixture config, not a real key or spend.
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
Object.assign(process.env, { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture-not-real', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' })
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
const Q = 'Independent dental practices hiring a receptionist in New York in the past 90 days'
const req = (body: unknown) => new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `198.51.100.${++n % 250}` }, body: JSON.stringify(body) })
// A keyless founder account (no own AI key): its scan draws on the trial.
function trialTenant() {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const id = (++n).toString(16).padStart(32, '0'), email = `founder${n}@gmail.com`
  raw.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')").run(id, email)
  raw.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)").run(`sub-${id}`, id)
  raw.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1700000000)").run(id, id)
  setUser({ id, business_name: 'b', email })
  return { raw, id }
}
const state = (raw: Database.Database, id: string) => ({
  jobs: raw.prepare('SELECT id, status, funded_by FROM scan_jobs WHERE user_id = ?').all(id) as { id: string; status: string; funded_by: string | null }[],
  trialScans: (raw.prepare('SELECT count(*) AS n FROM trial_scans WHERE tenant_id = ?').get(id) as { n: number }).n,
  reservations: raw.prepare('SELECT id, job_id, settled_at FROM trial_reservations WHERE tenant_id = ?').all(id) as { id: string; job_id: string | null; settled_at: number | null }[],
})
const fire = async (k: number) => Promise.all(Array.from({ length: k }, () => POST(req({ query: Q })))).then(rs => Promise.all(rs.map(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }))))

test('funded-trial race: the loser creates no job, no trial count, releases its linked reservation, and the winner keeps exactly one', async () => {
  const { raw, id } = trialTenant()
  const out = await fire(2)
  assert.deepEqual(out.map(o => o.status).sort(), [202, 409], JSON.stringify(out)); assert.equal(out.find(o => o.status === 409)!.body.error, 'scan_active')
  const s = state(raw, id), winner = out.find(o => o.status === 202)!.body.job_id as string
  assert.deepEqual(s.jobs.map(j => [j.id, j.funded_by]), [[winner, 'trial']], 'exactly one job, the winner, funded by the trial')
  assert.equal(s.trialScans, 1, 'only the winner consumed a trial attempt')
  assert.deepEqual(s.reservations.map(r => r.job_id), [winner], 'the loser reservation was released (deleted); the winner one stays linked to its job, unsettled')
  assert.equal(s.reservations[0].settled_at, null)
})

test('funded-trial race with five contenders: one job, one trial attempt, one reservation', async () => {
  const { raw, id } = trialTenant()
  const out = await fire(5)
  assert.equal(out.filter(o => o.status === 202).length, 1)
  const s = state(raw, id)
  assert.equal(s.jobs.length, 1); assert.equal(s.trialScans, 1); assert.equal(s.reservations.length, 1)
})

test('funded-trial: a failed release is fail-closed - the loser is still refused with no job, and its reservation is NOT given back', async () => {
  const { raw, id } = trialTenant()
  raw.exec("CREATE TRIGGER fail_release BEFORE DELETE ON trial_reservations BEGIN SELECT RAISE(ABORT, 'synthetic release failure'); END;")
  const out = await fire(2)
  assert.deepEqual(out.map(o => o.status).sort(), [202, 409], JSON.stringify(out)); assert.equal(out.find(o => o.status === 409)!.body.error, 'scan_active')
  const s = state(raw, id), winner = out.find(o => o.status === 202)!.body.job_id as string
  assert.deepEqual(s.jobs.map(j => j.id), [winner], 'the loser created no job')
  assert.equal(s.trialScans, 1, 'the loser consumed no trial attempt')
  assert.equal(s.reservations.length, 2, 'release failed: the loser reservation stays, counted at its full reserve (never less than it could spend)')
  const loser = s.reservations.find(r => r.job_id !== winner)!
  assert.ok(loser.job_id, 'it stays linked to the job id that was never created'); assert.equal(loser.settled_at, null, 'and is not recorded as a refund')
  assert.equal((raw.prepare('SELECT count(*) AS n FROM scan_jobs WHERE id = ?').get(loser.job_id) as { n: number }).n, 0, 'that job does not exist')
})

test('the enriching hold is explicit: a done scan still enriching blocks a new one; once enrichment finished it does not', async () => {
  for (const [started, finished, want] of [['CAST(strftime(\'%s\',\'now\') AS INTEGER)', 'NULL', 409], ['CAST(strftime(\'%s\',\'now\') AS INTEGER) - 60', 'CAST(strftime(\'%s\',\'now\') AS INTEGER)', 202]] as const) {
    const { raw, id } = trialTenant()
    const j = createQueryJob(raw, id, { query: Q, icp: null, sources: null, seller: null, offer: null, runBudget: null } as never)
    raw.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(j); raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(j)
    raw.prepare(`UPDATE scan_jobs SET enrich_started_at = ${started}, enrich_finished_at = ${finished} WHERE id = ?`).run(j)
    const [r] = await fire(1)
    assert.equal(r.status, want, `enrich finished=${finished}: ${JSON.stringify(r)}`)
    if (want === 409) { assert.equal(r.body.error, 'scan_active'); const s = state(raw, id); assert.equal(s.jobs.length, 1); assert.equal(s.reservations.length, 0, 'a refused request holds no reservation') }
  }
})
