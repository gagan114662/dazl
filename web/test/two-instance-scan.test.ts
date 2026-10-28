// Two app instances on one Postgres, at the scan level (docs/PLATFORM.md, cutover blockers). Each instance is a separate
// process with its own pool (test/helpers/scan-instance.mts, route-instance.mts). Covers, on the scan_jobs and leads
// rows themselves: each scan is claimed and run once, an instance killed mid-scan (SIGKILL) is recovered by the other
// with no duplicate lead writes, an attempt that lost its job writes nothing, and the real routes on each instance
// never return or touch the other tenant's scans. The scan itself is a stub (no provider, no fetch, no spend).
// multi-instance.test.ts covers the queue contract alone; this adds the domain rows the queue schedules.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pgDb, type Db } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { createJob, reapStaleJobs } from '../lib/scan/store-db.ts'
import { STALE_RUNNING_S } from '../lib/scan/store.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)
const web = fileURLToPath(new URL('../', import.meta.url))
const A = 'a'.repeat(32), B = 'b'.repeat(32)
const nowS = () => Math.floor(Date.now() / 1000)
const last = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1)!)

const childEnv = (env: Record<string, string>) => { const e: NodeJS.ProcessEnv = { ...process.env, ...env }; delete e.NODE_TEST_CONTEXT; return e }
const scanInstance = async (env: Record<string, string>) =>
  last((await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/scan-instance.mts'],
    { cwd: web, env: childEnv(env), encoding: 'utf8', timeout: 120_000 })).stdout)
const routeInstance = async (env: Record<string, string>) =>
  last((await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', './test/helpers/route-instance.mts'],
    { cwd: web, env: childEnv(env), encoding: 'utf8', timeout: 120_000 })).stdout)

async function sharedSchema() {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 4 })
  await runPgMigrations(db.pool)
  await db.run('CREATE TABLE scan_test_runs (job_id TEXT NOT NULL, attempt INTEGER NOT NULL, instance TEXT NOT NULL)')
  await db.run('CREATE TABLE scan_test_ready (instance TEXT NOT NULL)')
  for (const t of [A, B]) await db.run("INSERT INTO users (id, email, password_hash, salt, business_name, created_at) VALUES (?, ?, 'h', 's', 'Co', ?)", [t, `${t.slice(0, 4)}@example.test`, nowS()])
  return { s, db }
}
const newJob = async (db: Db, tenant: string, q?: DbQueue) => {
  const id = await createJob(db, tenant, { business_name: 'Co', industry: 'dental', location: 'Toronto' })
  if (q) await q.enqueue({ id, tenantId: tenant, kind: 'scan' })
  return id
}
// every job: one finished attempt, exactly its three leads, no lead twice
async function assertRunOnce(db: Db, ids: string[]) {
  const jobs = await db.all<{ id: string; status: string; verified: number }>('SELECT id, status, verified FROM scan_jobs ORDER BY id')
  assert.deepEqual(jobs.filter(j => j.status !== 'done'), [], 'every job finished')
  const leads = await db.all<{ scan_job_id: string; n: number; keys: number }>('SELECT scan_job_id, count(*)::int AS n, count(DISTINCT dedup_key)::int AS keys FROM leads GROUP BY scan_job_id')
  assert.equal(leads.length, ids.length)
  assert.deepEqual(leads.filter(l => l.n !== 3 || l.keys !== 3), [], 'each job has its three leads, none written twice')
}

test('[pg] two instances draining one queue: each scan is claimed, bound and run once; both instances work', { skip: pgSkip }, async () => {
  const { s, db } = await sharedSchema()
  try {
    const q = new DbQueue(db)
    const ids: string[] = []
    for (let i = 0; i < 30; i++) ids.push(await newJob(db, i % 2 ? A : B, q))
    const [a, b] = await Promise.all(['A', 'B'].map(n => scanInstance({ SI_NAME: n, SI_MODE: 'drain', SI_SCHEMA: s.schema })))
    const runs = await db.all<{ job_id: string; n: number }>('SELECT job_id, count(*)::int AS n FROM scan_test_runs GROUP BY job_id')
    assert.equal(runs.length, 30)
    assert.deepEqual(runs.filter(r => r.n !== 1), [], 'no scan ran twice')
    assert.equal(a.ran + b.ran, 30)
    assert.ok(a.ran > 0 && b.ran > 0, `both instances ran scans (A ${a.ran}, B ${b.ran})`)
    assert.equal(a.stale + b.stale, 0)
    await assertRunOnce(db, ids)
    assert.deepEqual(await db.all('SELECT DISTINCT attempts FROM scan_jobs'), [{ attempts: 1 }])
  } finally { await db.close(); await s.drop() }
})

test('[pg] two instances racing the bind with no queue: the conditional claim gives each scan to one instance', { skip: pgSkip }, async () => {
  const { s, db } = await sharedSchema()
  try {
    const ids: string[] = []
    for (let i = 0; i < 40; i++) ids.push(await newJob(db, i % 2 ? A : B))
    const [a, b] = await Promise.all(['A', 'B'].map(n => scanInstance({ SI_NAME: n, SI_MODE: 'race', SI_SCHEMA: s.schema })))
    assert.equal(a.won + b.won, 40, 'every scan bound exactly once')
    assert.equal(a.lost + b.lost, 40, 'every scan was also tried by the other instance, and refused')
    assert.ok(a.won > 0 && b.won > 0, `both instances won binds (A ${a.won}, B ${b.won})`)
    const runs = await db.all<{ n: number }>('SELECT count(*)::int AS n FROM scan_test_runs GROUP BY job_id HAVING count(*) > 1')
    assert.deepEqual(runs, [])
    await assertRunOnce(db, ids)
  } finally { await db.close(); await s.drop() }
})

test('[pg] an instance killed mid-scan: the other recovers the scan after the lease, runs it once more, and no lead is written twice', { skip: pgSkip }, async () => {
  const { s, db } = await sharedSchema()
  try {
    const q = new DbQueue(db)
    const victim = await newJob(db, A, q)
    const other = await newJob(db, B, q)
    // instance A takes the scan and is killed with it (SIGKILL: no shutdown hook, no finish, no queue release)
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/scan-instance.mts'],
      { cwd: web, env: childEnv({ SI_NAME: 'A', SI_MODE: 'crash', SI_SCHEMA: s.schema, SI_TENANT: A, SI_LEASE_S: '2' }) })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    while (!stdout.includes('holding')) await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(last(stdout), { holding: victim, attempt: 1 })
    child.kill('SIGKILL')
    await new Promise(r => child.once('exit', r))
    assert.equal((await db.get<{ status: string }>('SELECT status FROM scan_jobs WHERE id = ?', [victim]))!.status, 'running', 'held by a dead process')
    assert.equal((await q.get(victim))!.status, 'claimed')
    // later: the queue lease (2 s) runs out, and the scan reaper sees the job past STALE_RUNNING_S
    await new Promise(r => setTimeout(r, 2200))
    assert.equal(await reapStaleJobs(db, nowS() + STALE_RUNNING_S + 1), 1)
    await db.run("INSERT INTO scan_test_ready (instance) VALUES ('stand-in')") // B runs alone
    const b = await scanInstance({ SI_NAME: 'B', SI_MODE: 'drain', SI_SCHEMA: s.schema })
    assert.equal(b.ran, 2, 'the recovered scan and the other one')
    const runs = await db.all<{ job_id: string; attempt: number; instance: string }>('SELECT job_id, attempt, instance FROM scan_test_runs ORDER BY job_id, attempt')
    assert.deepEqual(runs.filter(r => r.job_id === victim).map(r => `${r.attempt}@${r.instance}`), ['1@A', '2@B'])
    assert.deepEqual(runs.filter(r => r.job_id === other).map(r => `${r.attempt}@${r.instance}`), ['1@B'])
    await assertRunOnce(db, [victim, other])
    assert.equal((await q.get(victim))!.status, 'done')
  } finally { await db.close(); await s.drop() }
})

test('[pg] an attempt that lost its scan to another instance cannot finish it: no leads, no status change, its queue token is stale', { skip: pgSkip }, async () => {
  const { s, db } = await sharedSchema()
  try {
    const q = new DbQueue(db)
    const job = await newJob(db, A, q)
    const stalled = execFile(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/scan-instance.mts'],
      { cwd: web, env: childEnv({ SI_NAME: 'A', SI_MODE: 'stall', SI_SCHEMA: s.schema, SI_TENANT: A, SI_LEASE_S: '2' }), encoding: 'utf8', timeout: 120_000 })
    let stdout = ''
    stalled.stdout!.on('data', d => { stdout += d })
    const exited = new Promise(r => stalled.once('exit', r))
    while (!(await db.get("SELECT 1 AS x FROM scan_test_ready WHERE instance = 'A'"))) await new Promise(r => setTimeout(r, 20))
    // A is stuck (a long GC pause, a lost connection): its lease runs out, the reaper frees the job, B runs it
    await new Promise(r => setTimeout(r, 2200))
    assert.equal(await reapStaleJobs(db, nowS() + STALE_RUNNING_S + 1), 1)
    await db.run("INSERT INTO scan_test_ready (instance) VALUES ('stand-in')")
    assert.equal((await scanInstance({ SI_NAME: 'B', SI_MODE: 'drain', SI_SCHEMA: s.schema })).ran, 1)
    const before = JSON.stringify(await db.all('SELECT id, scan_job_id, dedup_key, created_at FROM leads ORDER BY id'))
    await db.run("INSERT INTO scan_test_ready (instance) VALUES ('go')") // A wakes up and tries to finish attempt 1
    await exited
    assert.deepEqual(last(stdout), { job, attempt: 1, owned: false, completed: false })
    assert.equal(JSON.stringify(await db.all('SELECT id, scan_job_id, dedup_key, created_at FROM leads ORDER BY id')), before, 'the late attempt wrote nothing')
    const row = (await db.get<{ status: string; attempts: number }>('SELECT status, attempts FROM scan_jobs WHERE id = ?', [job]))!
    assert.deepEqual([row.status, Number(row.attempts)], ['done', 2])
    await assertRunOnce(db, [job])
  } finally { await db.close(); await s.drop() }
})

test('[pg] tenant isolation across instances through the real routes: each sees only its own scans and leads, and cannot act on the other\'s', { skip: pgSkip }, async () => {
  const { s, db } = await sharedSchema()
  try {
    const q = new DbQueue(db)
    const jobA = await newJob(db, A, q), jobB = await newJob(db, B, q)
    await db.run("INSERT INTO scan_test_ready (instance) VALUES ('stand-in')")
    await scanInstance({ SI_NAME: 'A', SI_MODE: 'drain', SI_SCHEMA: s.schema }) // one instance writes both tenants' scans
    await db.run("UPDATE leads SET review_reason = 'quote_not_found'") // so confirm has something to act on
    const leadOf = async (job: string) => (await db.get<{ id: string }>('SELECT id FROM leads WHERE scan_job_id = ? ORDER BY dedup_key LIMIT 1', [job]))!.id
    const snapshot = async () => JSON.stringify([await db.all('SELECT id, status, error FROM scan_jobs ORDER BY id'), await db.all('SELECT id, human_confirmed_at, quarantined_at FROM leads ORDER BY id')])
    const before = await snapshot()
    // each of two other instances signs in as one tenant and tries the other tenant's ids
    const [ra, rb] = await Promise.all([
      routeInstance({ RI_SCHEMA: s.schema, RI_TENANT: A, RI_OTHER: JSON.stringify({ job: jobB, lead: await leadOf(jobB) }) }),
      routeInstance({ RI_SCHEMA: s.schema, RI_TENANT: B, RI_OTHER: JSON.stringify({ job: jobA, lead: await leadOf(jobA) }) }),
    ])
    assert.deepEqual(ra.ownJobs, [jobA])
    assert.deepEqual(rb.ownJobs, [jobB])
    assert.match(ra.ownExport, new RegExp(`Company ${jobA.slice(0, 6)}`))
    assert.ok(!ra.ownExport.includes(jobB.slice(0, 6)) && !rb.ownExport.includes(jobA.slice(0, 6)), 'no export carries the other tenant\'s leads')
    for (const r of [ra, rb]) {
      assert.deepEqual([r.otherCampaign, r.otherConfirm, r.otherQuarantine, r.otherCancel], [404, 404, 404, 404])
      assert.ok(!r.otherExport.includes('Company '), 'export of the other tenant\'s job id returns no rows')
    }
    assert.equal(await snapshot(), before, 'no action changed the other tenant\'s rows')
  } finally { await db.close(); await s.drop() }
})
