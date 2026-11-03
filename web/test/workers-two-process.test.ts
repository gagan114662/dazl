// Runtime workers across two OS processes on one SQLite database (lib/workers, docs/design/runtime-workers.md). Each
// host is a separate node process with its own connection (test/helpers/worker-host-instance.mts); the operator acts
// from this process. Proves, with real concurrency: add and run; global and per-tenant in-flight limits hold across
// processes (and a process-local cap, the control, does not); admission under concurrent enqueue; stop by drain and by
// fence; restart; rollback with queued work preserved; crash after claim recovered by another process; a late or fenced
// completion changes nothing. Synthetic modules only (test/fixtures/workers); nothing leaves the host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { enqueueRun, getRun, type RunUser } from '../lib/workers/runtime.ts'
import { activate, deployment, events, grant, register, restart, setLimits, settle, start, stop } from '../lib/workers/store.ts'
import { pin, TEST_REGISTRY } from './helpers/worker-registry.ts'

const OP = 'op:tester'
const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c']
const user = (t: string): RunUser => ({ tenantId: t, actorId: t, role: 'owner' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Child = { code: number | null; out: Record<string, unknown>; err: string }
function host(file: string, name: string, env: Record<string, string>): Promise<Child> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/worker-host-instance.mts'],
      { env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', WH_DB: file, WH_NAME: name, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => {
      let parsed: Record<string, unknown> = {}
      try { parsed = out ? JSON.parse(out) : {} } catch { parsed = { unparsed: out } }
      resolve({ code, out: parsed, err })
    })
  })
}

async function fixture(): Promise<{ db: Db; file: string; done: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'dazl-workers-'))
  const file = join(dir, 'app.db')
  const raw = new Database(file)
  raw.pragma('journal_mode = WAL')
  raw.pragma('busy_timeout = 10000')
  migrateAllSqlite(raw)
  raw.exec(`CREATE TABLE wt_spans (item TEXT, tenant TEXT, host TEXT, t0 INTEGER, t1 INTEGER, outcome TEXT);
    CREATE TABLE wt_marks (host TEXT, what TEXT, item TEXT, at INTEGER);
    CREATE TABLE wt_ready (host TEXT)`)
  const db = sqliteDb(raw)
  for (const t of TENANTS) await db.run('INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)', [t, `${t}@example.test`, 'x', 'y'])
  return { db, file, done: async () => { await db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

async function deployEcho(db: Db, versions = ['1.0.0']) {
  for (const v of versions) await register(db, OP, { name: 'echo', version: v, codeHash: pin('echo', v) }, TEST_REGISTRY)
  await start(db, OP, 'echo', versions[0])
  for (const t of TENANTS) await grant(db, OP, t, 'echo')
}

// Highest number of spans open at once, overall and within one tenant.
function overlap(spans: { tenant: string; t0: number; t1: number }[]): { global: number; perTenant: number } {
  const peak = (xs: typeof spans) => {
    const ev = xs.flatMap(s => [[Number(s.t0), 1], [Number(s.t1), -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let n = 0, m = 0
    for (const [, d] of ev) { n += d; m = Math.max(m, n) }
    return m
  }
  const byTenant = new Map<string, typeof spans>()
  for (const s of spans) byTenant.set(s.tenant, [...(byTenant.get(s.tenant) ?? []), s])
  return { global: peak(spans), perTenant: Math.max(0, ...[...byTenant.values()].map(peak)) }
}
async function waitMark(db: Db, what: string): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const r = await db.get<{ item: string }>('SELECT item FROM wt_marks WHERE what = ?', [what])
    if (r) return r.item
    await sleep(10)
  }
  throw new Error(`no ${what} mark`)
}
async function enqueue(db: Db, n: number, input: (i: number) => Record<string, number>) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await enqueueRun(db, user(TENANTS[i % TENANTS.length]), 'echo', input(i))
    assert.ok(r.ok, JSON.stringify(r))
    ids.push(r.id)
  }
  return ids
}
const runs = (db: Db) => db.all<{ id: string; status: string; output: string | null; version: string | null; generation: number | null }>('SELECT id, status, output, version, generation FROM worker_runs ORDER BY id')

test('add a worker at runtime; two processes run every item exactly once; global and per-tenant limits hold across them', async () => {
  const { db, file, done } = await fixture()
  try {
    await deployEcho(db)
    await setLimits(db, OP, 'echo', { maxInFlight: 2, perTenantInFlight: 1 })
    const ids = await enqueue(db, 12, i => ({ n: i, sleepMs: 120 }))
    const env = { WH_MODE: 'drain', WH_CONC: '3', WH_BARRIER: '2' }
    const [h1, h2] = await Promise.all([host(file, 'h1', env), host(file, 'h2', env)])
    assert.equal(h1.code, 0, h1.err); assert.equal(h2.code, 0, h2.err)
    const spans = await db.all<{ item: string; tenant: string; host: string; t0: number; t1: number; outcome: string }>('SELECT * FROM wt_spans')
    // every item ran to completion exactly once, by both hosts between them
    assert.deepEqual(spans.filter(s => s.outcome === 'done').map(s => s.item).sort(), [...ids].sort())
    assert.equal(spans.length, 12)
    assert.ok(new Set(spans.map(s => s.host)).size === 2, 'both processes worked')
    const rs = await runs(db)
    assert.ok(rs.every(r => r.status === 'done' && JSON.parse(r.output!).by === '1.0.0'))
    const o = overlap(spans)
    assert.equal(o.global, 2, `global in-flight peak ${o.global}: the cap is 2 across both processes, and it was reached`)
    assert.equal(o.perTenant, 1, `per-tenant peak ${o.perTenant}`)
  } finally { await done() }
})

test('control: a process-local cap of 2 lets two processes exceed 2 in flight (what the shared limits prevent)', async () => {
  const { db, file, done } = await fixture()
  try {
    await deployEcho(db)
    await enqueue(db, 12, i => ({ n: i }))
    const env = { WH_MODE: 'local', WH_CONC: '3', WH_LOCAL_CAP: '2', WH_WORKER: 'echo', WH_SLEEP_MS: '120', WH_BARRIER: '2' }
    const [h1, h2] = await Promise.all([host(file, 'h1', env), host(file, 'h2', env)])
    assert.equal(h1.code, 0, h1.err); assert.equal(h2.code, 0, h2.err)
    const o = overlap(await db.all('SELECT * FROM wt_spans'))
    assert.ok(o.global > 2, `process-local caps peaked at ${o.global}`)
    assert.ok(o.perTenant > 1, `process-local caps let one tenant run ${o.perTenant} at once`)
  } finally { await done() }
})

test('admission: two processes enqueueing at once for one tenant admit exactly the backlog limit', async () => {
  const { db, file, done } = await fixture()
  try {
    await deployEcho(db)
    await setLimits(db, OP, 'echo', { maxBacklog: 5 })
    const env = { WH_MODE: 'enqueue', WH_TENANT: 'tenant-a', WH_WORKER: 'echo', WH_N: '6', WH_BARRIER: '2' }
    const [h1, h2] = await Promise.all([host(file, 'h1', env), host(file, 'h2', env)])
    assert.equal(h1.code, 0, h1.err); assert.equal(h2.code, 0, h2.err)
    assert.equal(Number(h1.out.ok) + Number(h2.out.ok), 5)
    assert.equal(Number(h1.out.backlog) + Number(h2.out.backlog), 7)
    assert.equal(Number((await db.get<{ c: number }>("SELECT count(*) AS c FROM work_queue WHERE tenant_id = 'tenant-a' AND status = 'pending'"))!.c), 5)
    assert.equal(Number((await db.get<{ c: number }>("SELECT count(*) AS c FROM worker_runs WHERE status = 'refused' AND error = 'backlog'"))!.c), 7)
    // another tenant is unaffected
    assert.equal((await enqueueRun(db, user('tenant-b'), 'echo', { n: 1 })).ok, true)
  } finally { await done() }
})

test('stop (drain): the in-flight item finishes, nothing new is claimed, then stopped; restart runs the rest', async () => {
  const { db, file, done } = await fixture()
  try {
    await deployEcho(db)
    await enqueue(db, 3, i => ({ n: i }))
    const holder = host(file, 'h1', { WH_MODE: 'hold' })
    const held = await waitMark(db, 'claimed')
    const d = await stop(db, OP, 'echo', { mode: 'drain', drainSeconds: 60 })
    assert.equal(d.state, 'draining')
    // a second process gets nothing while draining
    const idle = await host(file, 'h2', { WH_MODE: 'drain', WH_UNTIL: 'deadline', WH_DEADLINE_MS: '800' })
    assert.equal(idle.code, 0, idle.err)
    assert.deepEqual(idle.out, {})
    await db.run("INSERT INTO wt_marks (host, what, item, at) VALUES ('op', 'go', '', 0)")
    const h = await holder
    assert.deepEqual(h.out, { item: held, outcome: 'done' }, h.err)
    assert.equal((await settle(db, 'echo')).state, 'stopped')
    assert.equal(Number((await db.get<{ c: number }>("SELECT count(*) AS c FROM work_queue WHERE kind = 'worker:echo' AND status = 'pending'"))!.c), 2)
    // stopped: tenants cannot enqueue; restart: the two queued items run
    assert.deepEqual(await enqueueRun(db, user('tenant-a'), 'echo', { n: 9 }), { ok: false, error: 'unavailable' })
    const r = await restart(db, OP, 'echo')
    assert.equal(r.state, 'running')
    const h2 = await host(file, 'h2', { WH_MODE: 'drain' })
    assert.deepEqual(h2.out, { done: 2 }, h2.err)
    assert.ok((await runs(db)).filter(x => x.status !== 'refused').every(x => x.status === 'done'))
    const acts = (await events(db, { name: 'echo' })).map(e => e.action)
    assert.deepEqual(acts.slice(-3), ['stop', 'drained', 'restart'])
  } finally { await done() }
})

test('stop (fence): the in-flight claim loses ownership; its late completion changes nothing; restart reruns it under a new generation', async () => {
  const { db, file, done } = await fixture()
  try {
    await deployEcho(db)
    await enqueue(db, 1, () => ({ n: 41 }))
    const holder = host(file, 'h1', { WH_MODE: 'hold' })
    const held = await waitMark(db, 'claimed')
    const s = await stop(db, OP, 'echo', { mode: 'fence' })
    assert.deepEqual([s.state, s.generation], ['stopped', 2])
    assert.deepEqual(await db.get('SELECT status, claim_token FROM work_queue WHERE id = ?', [held]), { status: 'pending', claim_token: null })
    await db.run("INSERT INTO wt_marks (host, what, item, at) VALUES ('op', 'go', '', 0)")
    const h = await holder
    assert.deepEqual(h.out, { item: held, outcome: 'stale' }, h.err)
    const before = (await runs(db))[0]
    assert.deepEqual([before.status, before.output], ['queued', null])
    const r = await restart(db, OP, 'echo')
    assert.equal(r.generation, 3)
    const h2 = await host(file, 'h2', { WH_MODE: 'drain' })
    assert.deepEqual(h2.out, { done: 1 }, h2.err)
    const after = (await runs(db))[0]
    assert.deepEqual([after.status, JSON.parse(after.output!), Number(after.generation)], ['done', { n: 41, by: '1.0.0' }, 3])
    const stale = (await events(db, { name: 'echo' })).filter(e => e.action === 'complete_stale')
    assert.deepEqual(stale.map(e => [e.actor, e.generation, e.decision]), [['host:h1', 1, 'denied']])
  } finally { await done() }
})

test('upgrade then rollback while running: the in-flight claim is fenced, queued work is kept and runs on the rolled-back version', async () => {
  const { db, file, done } = await fixture()
  try {
    await deployEcho(db, ['1.0.0', '1.1.0', '2.0.0'])
    await activate(db, OP, 'echo', '1.1.0', 'upgrade')
    const [first] = await enqueue(db, 1, () => ({ n: 1 }))
    const h1 = await host(file, 'h1', { WH_MODE: 'drain' })
    assert.deepEqual(h1.out, { done: 1 }, h1.err)
    assert.equal(JSON.parse((await runs(db)).find(r => r.id === first)!.output!).by, '1.1.0')
    const queued = await enqueue(db, 3, i => ({ n: 10 + i }))
    const holder = host(file, 'h1', { WH_MODE: 'hold' })
    const held = await waitMark(db, 'claimed')
    // 2.0.0 changes the state shape: refused; 1.0.0 keeps it: allowed
    await assert.rejects(activate(db, OP, 'echo', '2.0.0', 'upgrade'), /incompatible_state/)
    const rb = await activate(db, OP, 'echo', '1.0.0', 'rollback')
    assert.deepEqual([rb.version, rb.state], ['1.0.0', 'running'])
    await db.run("INSERT INTO wt_marks (host, what, item, at) VALUES ('op', 'go', '', 0)")
    assert.deepEqual((await holder).out, { item: held, outcome: 'stale' })
    const h2 = await host(file, 'h2', { WH_MODE: 'drain' })
    assert.deepEqual(h2.out, { done: 3 }, h2.err)
    const rs = await runs(db)
    for (const id of queued) {
      const r = rs.find(x => x.id === id)!
      assert.deepEqual([r.status, JSON.parse(r.output!).by, r.version], ['done', '1.0.0', '1.0.0'])
    }
    // the run finished before the rollback keeps what 1.1.0 wrote
    assert.equal(JSON.parse(rs.find(r => r.id === first)!.output!).by, '1.1.0')
  } finally { await done() }
})

test('crash after claim: the process dies holding the item; another process recovers it after the lease and runs it once', async () => {
  const { db, file, done } = await fixture()
  try {
    await deployEcho(db)
    const [id] = await enqueue(db, 1, () => ({ n: 5 }))
    const crashed = await host(file, 'h1', { WH_MODE: 'crash' })
    assert.equal(crashed.code, 1)
    assert.deepEqual(crashed.out, { crashedOn: id })
    assert.equal((await db.get<{ status: string }>('SELECT status FROM work_queue WHERE id = ?', [id]))!.status, 'claimed')
    // the lease is the handler timeout (1s) plus LEASE_MARGIN_S (2s)
    const h2 = await host(file, 'h2', { WH_MODE: 'drain', WH_DEADLINE_MS: '10000' })
    assert.deepEqual(h2.out, { done: 1 }, h2.err)
    assert.deepEqual(await db.get('SELECT status, attempts FROM work_queue WHERE id = ?', [id]), { status: 'done', attempts: 2 })
    const r = await getRun(db, user('tenant-a'), id)
    assert.deepEqual([r?.status, r?.output], ['done', { n: 5, by: '1.0.0' }])
    assert.equal(Number((await db.get<{ c: number }>("SELECT count(*) AS c FROM wt_spans WHERE outcome = 'done'"))!.c), 1)
  } finally { await done() }
})

test('stale completion: a host that outlives its lease finishes after another host already did; its result is refused', async () => {
  const { db, file, done } = await fixture()
  try {
    await deployEcho(db)
    const [id] = await enqueue(db, 1, () => ({ n: 8 }))
    const late = host(file, 'h1', { WH_MODE: 'late', WH_DEADLINE_MS: '15000' })
    await waitMark(db, 'claimed')
    const h2 = await host(file, 'h2', { WH_MODE: 'drain', WH_DEADLINE_MS: '10000' })
    assert.deepEqual(h2.out, { done: 1 }, h2.err)
    const l = await late
    assert.deepEqual(l.out, { item: id, outcome: 'stale' }, l.err)
    const r = await getRun(db, user('tenant-a'), id)
    assert.deepEqual(r?.output, { n: 8, by: '1.0.0' }) // not the late host's {n: -1}
    assert.equal((await deployment(db, 'echo'))!.state, 'running')
  } finally { await done() }
})
