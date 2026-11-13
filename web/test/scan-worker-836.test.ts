// #836: jobs survive a restart and run once across two workers, on the store production runs on (one SQLite file).
// Each worker is a separate OS process running the production worker entry point (lib/scan/worker.ts scanWorkerMain,
// what scripts/scan-worker.mts and ops/staging/dazl-staging-worker.service start) with DAZL_SCAN_SHARED_QUEUE=1; only
// the model provider and the page fetch are stubs (test/helpers/scan-worker-child.mts). What is read back is what the
// live check reads: work_queue (attempts, token, claimed_by, claim_log), scan_jobs, leads and each worker's journal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { stagingScanHoldMs } from '../lib/queue/scan-claimer.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { migrateOnboardingPolicy } from '../lib/outreach/onboarding-policy.ts'
import { migrateEvidenceCopies } from '../lib/scan/evidence-copies.ts'
import { migrateTenantLifecycle } from '../lib/db/tenant-guard.ts'
import { createJob, STALE_RUNNING_S } from '../lib/scan/store.ts'
import { workerPass, workerIntervalMs, workerConcurrency } from '../lib/scan/worker.ts'

const web = fileURLToPath(new URL('../', import.meta.url))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (cond: () => boolean, what: string, ms = 30_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(25) } }
const nowS = () => Math.floor(Date.now() / 1000)

interface QRow { id: string; status: string; attempts: number; claim_token: number | null; claimed_by: string | null; claim_log: string | null }
interface Entry { attempt: number; token: number; by: string | null; at: number }

function world(tenants: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'w836-')), path = join(dir, 'app.db')
  const db = new Database(path); db.pragma('journal_mode = WAL'); migrateAllSqlite(db)
  const master = randomBytes(32)
  for (const t of tenants) {
    db.prepare("INSERT INTO users (id, email, business_name, password_hash, salt, created_at) VALUES (?, ?, ?, 'x', 'x', ?)").run(t, `${t}@example.test`, `${t} Co`, nowS())
    saveKey(db, t, 'anthropic', 'sk-ant-api03-' + t.padEnd(32, 'A'), master)
  }
  const workers: { name: string; proc: ChildProcess; out: () => string }[] = []
  const start = (name: string, env: Record<string, string> = {}) => {
    const e: NodeJS.ProcessEnv = { ...process.env, DB_PATH: path, W_NAME: name.replace(/^worker-/, ''), W_MASTER: master.toString('base64'), W_MODE: 'answer', DAZL_SCAN_SHARED_QUEUE: '1',
      SCAN_WORKER_INTERVAL_MS: '250', SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_ENV: 'test', ...env }
    delete e.NODE_TEST_CONTEXT; delete e.DATABASE_URL
    const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/scan-worker-child.mts'], { cwd: web, env: e, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout!.on('data', d => { out += d }); proc.stderr!.on('data', d => { out += d })
    const w = { name, proc, out: () => out }
    workers.push(w)
    return w
  }
  const stop = async (w: { proc: ChildProcess }, sig: NodeJS.Signals = 'SIGTERM') => { if (w.proc.exitCode !== null || w.proc.signalCode !== null) return; const gone = new Promise(r => w.proc.once('exit', r)); w.proc.kill(sig); await gone }
  const close = async () => { for (const w of workers) await stop(w, 'SIGKILL'); db.close(); rmSync(dir, { recursive: true, force: true }) }
  const scan = (t: string) => createJob(db, t, { business_name: 'Scan', industry: 'roofing', location: 'Toronto' })
  const queueRow = (id: string) => db.prepare('SELECT id, status, attempts, claim_token, claimed_by, claim_log FROM work_queue WHERE id = ?').get(id) as QRow | undefined
  const log = (id: string): Entry[] => JSON.parse(queueRow(id)?.claim_log ?? '[]')
  const job = (id: string) => db.prepare('SELECT status, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; attempts: number }
  // a scan's lead rows, and how many distinct leads they are: equal means none was written twice
  const leads = (id: string) => db.prepare("SELECT count(*) AS n, count(DISTINCT company || '|' || source_url) AS d FROM leads WHERE scan_job_id = ?").get(id) as { n: number; d: number }
  const lines = (w: { out: () => string }, re: RegExp) => w.out().split('\n').filter(l => re.test(l))
  return { db, start, stop, close, scan, queueRow, log, job, leads, lines }
}

test('#836 two worker processes on one store: every scan is claimed and run once, both workers take scans, and work_queue says which worker ran each', async () => {
  const tenants = ['t1', 't2', 't3', 't4', 't5', 't6']
  const w = world(tenants)
  try {
    const ids = tenants.map(t => w.scan(t))
    const a = w.start('worker-a', { W_SLOW_MS: '400' }), b = w.start('worker-b', { W_SLOW_MS: '400' })
    await until(() => ids.every(id => w.job(id).status === 'done'), 'every scan done')
    await until(() => ids.every(id => w.queueRow(id)?.status === 'done'), 'every queue item settled')
    for (const id of ids) {
      assert.deepEqual(w.job(id), { status: 'done', attempts: 1 }, 'one attempt')
      const q = w.queueRow(id)!
      assert.equal(q.attempts, 1); assert.equal(q.claim_token, null)
      const entries = w.log(id)
      assert.equal(entries.length, 1, 'claimed once')
      assert.equal(entries[0].by, q.claimed_by)
      assert.ok(q.claimed_by === 'worker-a' || q.claimed_by === 'worker-b')
      assert.deepEqual(w.leads(id), { n: 1, d: 1 }, 'its lead, written once')
      // the journals agree with the store: one claim and one applied settle for the scan, both on the worker named
      const claimed = [a, b].flatMap(x => w.lines(x, new RegExp(`\\[shared-queue\\] claimed scan=${id} `)))
      assert.equal(claimed.length, 1, 'one claim line across both journals')
      assert.match(claimed[0], new RegExp(`attempt=1 token=${entries[0].token} instance=${q.claimed_by}$`))
      const settled = [a, b].flatMap(x => w.lines(x, new RegExp(`\\[shared-queue\\] settled scan=${id} `)))
      assert.equal(settled.length, 1)
      assert.match(settled[0], new RegExp(`outcome=done applied=true instance=${q.claimed_by}$`))
    }
    const by = new Set(ids.map(id => w.queueRow(id)!.claimed_by))
    assert.deepEqual([...by].sort(), ['worker-a', 'worker-b'], 'both workers took scans')
    assert.equal(new Set(ids.map(id => w.log(id)[0].token)).size, ids.length, 'every claim has its own fencing token')
  } finally { await w.close() }
})

test('#836 a worker restarted mid-scan (SIGTERM) with no paid request in flight hands the scan back and the other worker finishes it once: attempts 2, a higher token, both workers in the claim log, no duplicate lead (the staging pause makes that window)', async () => {
  const w = world(['t1'])
  try {
    const id = w.scan('t1')
    // worker-a claims the scan and sits in the staging-only pause: running, its claim live, no provider call yet
    const a = w.start('worker-a', { DAZL_ENV: 'staging', DAZL_STAGING_SCAN_HOLD_MS: '60000' })
    await until(() => w.job(id).status === 'running' && /\[shared-queue\] staging hold scan=/.test(a.out()), 'worker-a holds the scan')
    assert.match(w.lines(a, /staging hold/)[0], new RegExp(`staging hold scan=${id} attempt=1 ms=60000 instance=worker-a`))
    assert.equal(w.queueRow(id)!.claimed_by, 'worker-a')
    const first = w.log(id)[0]
    const b = w.start('worker-b')
    await until(() => /\[scan-worker\] started instance=worker-b shared_queue=on/.test(b.out()), 'worker-b up')
    await sleep(600) // worker-b has looked more than once and left the live claim alone
    assert.deepEqual(w.job(id), { status: 'running', attempts: 1 }, 'a live claim is not taken')
    assert.equal(w.lines(b, /claimed scan=/).length, 0)
    assert.equal(w.lines(a, /provider call/).length, 0, 'no paid request was made during the pause')
    await w.stop(a, 'SIGTERM')
    await until(() => w.job(id).status === 'done', 'worker-b finished the scan')
    await until(() => w.queueRow(id)!.status === 'done', 'queue item settled')
    assert.deepEqual(w.job(id), { status: 'done', attempts: 2 })
    const q = w.queueRow(id)!
    assert.equal(q.attempts, 2); assert.equal(q.claimed_by, 'worker-b')
    const entries = w.log(id)
    assert.deepEqual(entries.map(e => [e.attempt, e.by]), [[1, 'worker-a'], [2, 'worker-b']])
    assert.ok(entries[1].token > first.token, 'the second claim has a higher fencing token')
    assert.deepEqual(w.leads(id), { n: 1, d: 1 }, 'the lead is written once')
    assert.equal(w.lines(a, /settled scan=/).length, 0, 'the stopped worker settled nothing')
    assert.match(w.lines(a, /\[scan-worker\] SIGTERM/)[0] ?? '', /stopping instance=worker-a/)
    assert.equal(w.lines(b, new RegExp(`claimed scan=${id} attempt=2 token=${entries[1].token} instance=worker-b`)).length, 1)
    assert.equal(w.lines(b, /provider call/).length, 1, 'the scan ran once')
    assert.equal((w.db.prepare('SELECT count(*) AS n FROM work_queue').get() as { n: number }).n, 1, 'one queue row for the scan')
  } finally { await w.close() }
})

test('#836 a worker restarted (SIGTERM) while a paid request is in flight (its ledger reservation written by the test: the stub provider records none): the scan is NOT handed back and never run again; after the lease it ends failed accounting_uncertain at attempt 1 and its queue item is closed without a second run', async () => {
  const w = world(['t1'])
  try {
    const id = w.scan('t1')
    const a = w.start('worker-a', { W_MODE: 'hang' })
    await until(() => w.job(id).status === 'running' && /provider call 1/.test(a.out()), 'worker-a is mid-scan')
    // the paid request in flight, as the spend ledger records it before the provider is called (lib/scan/spend-cap.ts)
    w.db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('call-1', 't1', ?, 1, 'llm.anthropic', 0.02, 'reserved', ?)").run(id, nowS())
    const b = w.start('worker-b')
    await until(() => /started instance=worker-b/.test(b.out()), 'worker-b up')
    await w.stop(a, 'SIGTERM')
    await sleep(900)
    assert.deepEqual(w.job(id), { status: 'running', attempts: 1 }, 'not handed back: the request may have been billed')
    assert.equal(w.queueRow(id)!.status, 'claimed', 'the claim stays until its lease')
    // the lease runs out
    const past = nowS() - STALE_RUNNING_S - 5
    w.db.prepare('UPDATE scan_jobs SET claimed_at = ? WHERE id = ?').run(past, id)
    w.db.prepare('UPDATE work_queue SET claimed_at = ?, lease_expires_at = ? WHERE id = ?').run(past, past + STALE_RUNNING_S, id)
    await until(() => w.job(id).status === 'failed', 'the scan is ended closed')
    assert.deepEqual(w.db.prepare('SELECT status, error, attempts FROM scan_jobs WHERE id = ?').get(id), { status: 'failed', error: 'accounting_uncertain', attempts: 1 })
    await until(() => w.queueRow(id)!.status !== 'claimed', 'expired claim reaped')
    w.db.prepare("UPDATE work_queue SET not_before = ? WHERE id = ? AND status = 'pending'").run(nowS(), id)
    await until(() => w.queueRow(id)!.status === 'done', 'queue item closed')
    assert.equal(w.lines(b, /claimed scan=/).length, 0, 'worker-b never ran it')
    assert.equal(w.lines(b, /provider call/).length, 0)
    assert.match(w.lines(b, /nothing to run/)[0] ?? '', new RegExp(`nothing to run scan=${id} token=\\d+ scan_status=failed instance=worker-b`))
    assert.deepEqual(w.leads(id), { n: 0, d: 0 })
    assert.equal(w.job(id).attempts, 1)
  } finally { await w.close() }
})

test('#836 a worker killed mid-scan (SIGKILL) keeps its claim until the lease runs out; then the other worker takes the scan and finishes it once', async () => {
  const w = world(['t1'])
  try {
    const id = w.scan('t1')
    const a = w.start('worker-a', { W_MODE: 'hang' })
    await until(() => w.job(id).status === 'running' && /provider call 1/.test(a.out()), 'worker-a is mid-scan')
    await w.stop(a, 'SIGKILL')
    const b = w.start('worker-b')
    await until(() => /started instance=worker-b/.test(b.out()), 'worker-b up')
    await sleep(800)
    assert.deepEqual(w.job(id), { status: 'running', attempts: 1 }, 'inside the lease the dead worker still holds the scan')
    assert.equal(w.queueRow(id)!.status, 'claimed')
    // the lease runs out: STALE_RUNNING_S later, written here as the two timestamps the lease is read from
    const past = nowS() - STALE_RUNNING_S - 5
    w.db.prepare('UPDATE scan_jobs SET claimed_at = ? WHERE id = ?').run(past, id)
    w.db.prepare('UPDATE work_queue SET claimed_at = ?, lease_expires_at = ? WHERE id = ?').run(past, past + STALE_RUNNING_S, id)
    // the dead claim returns with the queue's retry backoff; the check below does not wait it out
    await until(() => w.queueRow(id)!.status !== 'claimed' || w.job(id).status === 'done', 'expired claim reaped')
    w.db.prepare("UPDATE work_queue SET not_before = ? WHERE id = ? AND status = 'pending'").run(nowS(), id)
    await until(() => w.job(id).status === 'done', 'worker-b finished the scan', 60_000)
    await until(() => w.queueRow(id)!.status === 'done', 'queue item settled')
    assert.deepEqual(w.job(id), { status: 'done', attempts: 2 })
    assert.deepEqual(w.log(id).map(e => [e.attempt, e.by]), [[1, 'worker-a'], [2, 'worker-b']])
    assert.ok(w.log(id)[1].token > w.log(id)[0].token)
    assert.deepEqual(w.leads(id), { n: 1, d: 1 })
  } finally { await w.close() }
})

test('#836 the worker script: with the flag off, or with DATABASE_URL set, it idles and claims nothing; started by its real command line it names itself worker-<id> and stops on SIGTERM', async () => {
  const w = world(['t1'])
  try {
    const id = w.scan('t1')
    // pgUrl: started without the test fence (which removes DATABASE_URL); the worker must stay idle, so nothing connects
    const run = (flag: string | undefined, pgUrl?: string, workerId?: string) => new Promise<string>((res, rej) => {
      const e: NodeJS.ProcessEnv = { ...process.env, DB_PATH: w.db.name, SCAN_WORKER_INTERVAL_MS: '250', NODE_ENV: 'test', DAZL_INSTANCE_ID: 'the-app' }
      delete e.NODE_TEST_CONTEXT; delete e.DATABASE_URL; delete e.SCAN_WORKER_ID; delete e.DAZL_SCAN_SHARED_QUEUE
      if (flag !== undefined) e.DAZL_SCAN_SHARED_QUEUE = flag
      if (pgUrl) e.DATABASE_URL = pgUrl
      if (workerId !== undefined) e.SCAN_WORKER_ID = workerId
      const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', ...(pgUrl ? [] : ['--import', './test/helpers/net-fence.ts']), 'scripts/scan-worker.mts'], { cwd: web, env: e, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''; p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
      p.once('error', rej)
      p.once('exit', code => code === 143 ? res(out) : rej(new Error(`exit ${code}: ${out}`)))
      void (async () => { await until(() => /\[scan-worker\] started/.test(out) || p.exitCode !== null, 'script started'); await sleep(900); p.kill('SIGTERM') })().catch(rej)
    })
    for (const flag of [undefined, 'true']) {
      const out = await run(flag)
      assert.match(out, /\[scan-worker\] started instance=worker-[0-9a-f]{8} shared_queue=off concurrency=1 interval_ms=250/)
      assert.match(out, /DAZL_SCAN_SHARED_QUEUE is not 1: idle/)
      assert.match(out, /\[scan-worker\] SIGTERM: stopping/)
      assert.deepEqual(w.job(id), { status: 'pending', attempts: 0 }, 'flag off: the scan is left to the app')
      assert.equal((w.db.prepare('SELECT count(*) AS n FROM work_queue').get() as { n: number }).n, 0)
    }
    // SCAN_WORKER_ID names the worker; a malformed one (a space, 49 characters) falls back to 8 random hex
    assert.match(await run(undefined, undefined, 'box-2'), /started instance=worker-box-2 shared_queue=off/)
    for (const bad of ['a b', 'x'.repeat(49)]) assert.match(await run(undefined, undefined, bad), /started instance=worker-[0-9a-f]{8} shared_queue=off/, bad.slice(0, 8))
    // DATABASE_URL set (the queue would be on Postgres, the scan rows in this file): idle even with the flag on
    const split = await run('1', 'postgres://127.0.0.1:1/none')
    assert.match(split, /\[scan-worker\] started instance=worker-[0-9a-f]{8} shared_queue=off/, 'and an instance id set for the app in the shared env file is never the worker\'s')
    assert.match(split, /DATABASE_URL is set: this worker is for the one-file store only: idle/)
    assert.deepEqual(w.job(id), { status: 'pending', attempts: 0 })
  } finally { await w.close() }
})

test('#836 worker pass: off without the flag, idle (no write, no kick) with no pending or running scan, a kick otherwise; interval and concurrency settings fail to their defaults', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  let kicks = 0
  const kick = async () => { kicks++ }
  const on = { DAZL_SCAN_SHARED_QUEUE: '1' }
  assert.equal(await workerPass({ db, kick, env: {} }), 'off')
  assert.equal(await workerPass({ db, kick, env: on }), 'idle')
  const before = db.prepare('SELECT total_changes() AS n').get() as { n: number }
  assert.equal(await workerPass({ db, kick, env: on }), 'idle')
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before, 'an idle pass writes nothing')
  assert.equal(kicks, 0)
  db.prepare("INSERT INTO users (id, email, business_name, password_hash, salt, created_at) VALUES ('t1', 't1@example.test', 'Co', 'x', 'x', 1)").run()
  const id = createJob(db, 't1', { business_name: 'Scan', industry: 'roofing', location: 'Toronto' })
  assert.equal(await workerPass({ db, kick, env: on }), 'kicked')
  db.prepare("UPDATE scan_jobs SET status = 'running', claimed_at = 1 WHERE id = ?").run(id)
  assert.equal(await workerPass({ db, kick, env: on }), 'kicked', 'a running scan is work: the kick frees it when its worker died')
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
  assert.equal(await workerPass({ db, kick, env: on }), 'idle')
  assert.equal(kicks, 2)
  // a scan's queue item still open after its scan ended is work too: the kick closes it
  const q = new DbQueue(sqliteDb(db))
  await q.enqueue({ id, tenantId: 't1', kind: 'scan' })
  assert.equal(await workerPass({ db, kick, env: on }), 'kicked')
  const c = (await q.claim({ kinds: ['scan'] }))!
  assert.equal(await workerPass({ db, kick, env: on }), 'kicked')
  await q.complete(c.token)
  await q.enqueue({ id: 'other', tenantId: 't1', kind: 'text-stats' })
  assert.equal(await workerPass({ db, kick, env: on }), 'idle', 'another kind of queue work is not the scan worker\'s')
  assert.equal(kicks, 4)
  // a store with no scan tables yet: the worker creates nothing and waits
  const empty = new Database(':memory:')
  assert.equal(await workerPass({ db: empty, kick, env: on }), 'not_ready')
  assert.equal((empty.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n, 0, 'the worker changes no schema')
  assert.equal(kicks, 4)
  empty.close()
  assert.equal(workerIntervalMs({}), 5000)
  for (const [v, n] of [['250', 250], ['60000', 60000], [' 1000 ', 1000]] as const) assert.equal(workerIntervalMs({ SCAN_WORKER_INTERVAL_MS: v }), n)
  for (const v of ['', '0', '249', '60001', '1e3', '-5', 'abc', '5s', '9'.repeat(40)]) assert.equal(workerIntervalMs({ SCAN_WORKER_INTERVAL_MS: v }), 5000, v.slice(0, 8))
  // the staging-only pause: staging AND 1..120000 only; production never reads it
  assert.equal(stagingScanHoldMs({ DAZL_ENV: 'staging', DAZL_STAGING_SCAN_HOLD_MS: '45000' }), 45000)
  assert.equal(stagingScanHoldMs({ DAZL_ENV: 'staging', DAZL_STAGING_SCAN_HOLD_MS: ' 120000 ' }), 120000)
  for (const e of [{}, { DAZL_STAGING_SCAN_HOLD_MS: '45000' }, { DAZL_ENV: 'production', DAZL_STAGING_SCAN_HOLD_MS: '45000' }, { DAZL_ENV: 'Staging', DAZL_STAGING_SCAN_HOLD_MS: '45000' }, { DAZL_ENV: 'staging' }]) assert.equal(stagingScanHoldMs(e), 0, JSON.stringify(e))
  for (const v of ['0', '120001', '-1', '1.5', '1e3', 'abc', '', '45s']) assert.equal(stagingScanHoldMs({ DAZL_ENV: 'staging', DAZL_STAGING_SCAN_HOLD_MS: v }), 0, v)
  assert.equal(workerConcurrency({}), 1)
  for (const [v, n] of [['1', 1], ['8', 8], [' 2 ', 2]] as const) assert.equal(workerConcurrency({ SCAN_WORKER_CONCURRENCY: v }), n)
  for (const v of ['0', '9', '1.5', 'abc', '', '-1']) assert.equal(workerConcurrency({ SCAN_WORKER_CONCURRENCY: v }), 1, v)
  db.close()
})

test('#836 claim record: DbQueue.claim stores the owner as claimed_by and appends {attempt, token, by, at} to a claim log capped at 8; a malformed owner is not recorded; settle keeps the last claimer', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const q = new DbQueue(sqliteDb(raw), { backoff: { baseSeconds: 0, jitter: 0 } })
  await q.enqueue({ id: 's1', tenantId: 't1', kind: 'scan', maxAttempts: 20, now: 100 })
  const c1 = (await q.claim({ kinds: ['scan'], owner: 'web-1', now: 100 }))!
  assert.equal(c1.item.claimedBy, 'web-1')
  assert.deepEqual(c1.item.claimLog, [{ attempt: 1, token: c1.token, by: 'web-1', at: 100 }])
  await q.fail(c1.token, { retryable: true, now: 100 })
  assert.equal((await q.get('s1'))!.claimedBy, 'web-1', 'kept after the claim is released')
  const c2 = (await q.claim({ kinds: ['scan'], owner: 'worker-2', now: 200 }))!
  assert.deepEqual(c2.item.claimLog!.map(e => [e.attempt, e.by, e.at]), [[1, 'web-1', 100], [2, 'worker-2', 200]])
  assert.ok(c2.token > c1.token)
  await q.fail(c2.token, { retryable: true, now: 200 })
  for (const bad of ['has space', 'x'.repeat(65), '', 'semi;colon', '{"by":1}']) {
    const c = (await q.claim({ kinds: ['scan'], owner: bad, now: 300 }))!
    assert.equal(c.item.claimedBy, null, bad)
    await q.fail(c.token, { retryable: true, now: 300 })
  }
  for (let i = 0; i < 4; i++) { const c = (await q.claim({ kinds: ['scan'], now: 400 + i }))!; await q.fail(c.token, { retryable: true, now: 400 + i }) }
  const done = (await q.claim({ kinds: ['scan'], owner: 'worker-2', now: 500 }))!
  assert.equal(done.item.claimLog!.length, 8, 'capped')
  assert.deepEqual(done.item.claimLog!.at(-1), { attempt: 12, token: done.token, by: 'worker-2', at: 500 })
  assert.equal(done.item.claimLog![0].attempt, 5, 'the oldest entries are dropped')
  assert.equal(await q.complete(done.token), true)
  const end = (await q.get('s1'))!
  assert.equal(end.status, 'done'); assert.equal(end.claimedBy, 'worker-2'); assert.equal(end.claimLog!.length, 8)
  // an unreadable stored log reads as empty and the next claim starts a fresh one
  await q.enqueue({ id: 's2', tenantId: 't2', kind: 'scan', now: 600 })
  raw.prepare("UPDATE work_queue SET claim_log = 'not json' WHERE id = 's2'").run()
  const c = (await q.claim({ kinds: ['scan'], owner: 'web-1', now: 600 }))!
  assert.deepEqual(c.item.claimLog, [{ attempt: 1, token: c.token, by: 'web-1', at: 600 }])
  raw.close()
})

test('#836 a store created before the claim columns gets them when the queue adapter opens it, once, and existing rows survive', () => {
  const raw = new Database(':memory:')
  raw.exec(`CREATE TABLE work_queue (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
    not_before INTEGER NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER, lease_expires_at INTEGER, claim_token INTEGER, last_error TEXT, dedupe_key TEXT);
    INSERT INTO work_queue (id, tenant_id, kind, status, attempts, max_attempts, not_before, created_at) VALUES ('old', 't1', 'scan', 'done', 1, 3, 1, 1)`)
  migrateAllSqlite(raw); migrateAllSqlite(raw)
  const cols = (raw.prepare('PRAGMA table_info(work_queue)').all() as { name: string }[]).map(c => c.name)
  assert.deepEqual(cols.filter(c => c === 'claimed_by' || c === 'claim_log'), ['claimed_by', 'claim_log'])
  assert.deepEqual(raw.prepare("SELECT id, status, claimed_by, claim_log FROM work_queue").all(), [{ id: 'old', status: 'done', claimed_by: null, claim_log: null }])
  raw.close()
})

test('#836 four processes opening one store at the same instant all finish its setup: every trigger the setup replaces (deleted-tenant guards, onboarding audit, evidence copies) is replaced under one write lock, never "trigger ... already exists"', async () => {
  const w = world(['t1'])
  try {
    const go = String(Date.now() + 1500)
    const runs = await Promise.all([1, 2, 3, 4].map(() => new Promise<{ code: number | null; out: string }>(res => {
      const e: NodeJS.ProcessEnv = { ...process.env, DB_PATH: w.db.name, W_GO: go, W_ROUNDS: '25' }
      delete e.NODE_TEST_CONTEXT
      const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', './test/helpers/store-open-child.mts'], { cwd: web, env: e, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''; p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
      p.once('exit', code => res({ code, out }))
    })))
    assert.deepEqual(runs.map(r => r.code === 0 ? 'ok' : r.out.split('\n').find(l => /Error/.test(l)) ?? `exit ${r.code}`), ['ok', 'ok', 'ok', 'ok'])
    // and the guards are all there afterwards: a scan for a tombstoned tenant is still refused
    const triggers = (w.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'tomb_%'").get() as { n: number }).n
    assert.ok(triggers > 50, `guard triggers present (${triggers})`)
  } finally { await w.close() }
})

test('#836 every DROP TRIGGER the store setup issues runs inside a transaction (deterministic: each statement is checked as it is issued)', () => {
  // better-sqlite3 calls `verbose` with each SQL text before running it; db.inTransaction then says whether a
  // transaction is open. A DROP TRIGGER issued outside one is the cross-process race this change closed.
  const outside: string[] = []; let drops = 0
  const db: Database.Database = new Database(':memory:', { verbose: (sql?: unknown) => {
    if (typeof sql !== 'string' || !/DROP TRIGGER/i.test(sql)) return
    drops++
    if (!db.inTransaction) outside.push(sql.replace(/\s+/g, ' ').slice(0, 90))
  } })
  migrateAllSqlite(db)
  migrateOnboardingPolicy(db); migrateEvidenceCopies(db); migrateTenantLifecycle(db)
  assert.ok(drops >= 3, `the setup replaces triggers (${drops} DROP statements seen)`)
  assert.deepEqual(outside, [])
  db.close()
})
