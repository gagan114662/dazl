// Runtime worker catalog and lifecycle (lib/workers, docs/design/runtime-workers.md), on SQLite and Postgres: only
// reviewed modules register, by exact name, version and code hash; registration grants nothing (send/spend effects and
// undeclared capabilities never start, a tenant needs a grant); every change and refusal is in the append-only trail;
// tenants only see their own runs; hostile handler output never becomes a result; crash loops stop and restart only a
// bounded number of times. Synthetic modules only (test/fixtures/workers); nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { checkDefinition, key, type Registry } from '../lib/workers/definition.ts'
import { REVIEWED } from '../lib/workers/registry.ts'
import { MAX_DEPTH } from '../lib/workers/schema.ts'
import { enqueueRun, getRun, listRuns, WorkerHost, CRASH_LOOP_FAILURES, MAX_AUTO_RESTARTS, type RunUser } from '../lib/workers/runtime.ts'
import { activate, deployment, events, grant, register, restart, revoke, setLimits, start, stop, WorkerError } from '../lib/workers/store.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { bothEngines } from './helpers/engines.ts'
import { pin, sha, TEST_REGISTRY } from './helpers/worker-registry.ts'

const OP = 'op:tester'
const A: RunUser = { tenantId: 'tenant-a', actorId: 'tenant-a', role: 'owner' }
const B: RunUser = { tenantId: 'tenant-b', actorId: 'tenant-b', role: 'owner' }
const NOW = 1_800_000_000

async function seed(db: Db) {
  for (const t of [A, B]) await db.run('INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)', [t.tenantId, `${t.tenantId}@example.test`, 'x', 'y'])
}
async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof WorkerError && e.code === code, `expected refusal ${code}`)
}
async function deployEcho(db: Db, version = '1.0.0') {
  await register(db, OP, { name: 'echo', version, codeHash: pin('echo', version) }, TEST_REGISTRY, NOW)
  await start(db, OP, 'echo', version, NOW)
  await grant(db, OP, A.tenantId, 'echo', NOW)
}
const host = (db: Db, registry: Registry = TEST_REGISTRY, clock = () => NOW) => new WorkerHost(db, { registry, instance: 't', backoff: { baseSeconds: 0, jitter: 0 }, clock })

test('the reviewed registry this build ships: every pin equals its file, every definition is valid and runnable', () => {
  assert.ok(REVIEWED.size >= 1)
  for (const [k, e] of REVIEWED) {
    assert.equal(sha(e.file), e.sha256, `${k}: re-pin lib/workers/registry.ts after reviewing the change`)
    assert.equal(checkDefinition(e.module.definition), null, k)
    assert.equal(key(e.module.definition.name, e.module.definition.version), k)
  }
})

test('checkDefinition refuses malformed definitions of every shape', () => {
  const good = TEST_REGISTRY.get('echo@1.0.0')!.module.definition
  assert.equal(checkDefinition(good), null)
  const deep = (n: number): unknown => n === 0 ? { type: 'null' } : { type: 'array', items: deep(n - 1), maxItems: 1 }
  const bad: unknown[] = [
    null, [], 'echo', 42, true, new (class X {})(),
    { ...good, extra: 1 }, { ...good, name: 'Echo' }, { ...good, name: 'e' }, { ...good, name: 'x'.repeat(41) }, { ...good, name: 7 },
    { ...good, version: '1.0' }, { ...good, version: '01.0.0' }, { ...good, version: ['1.0.0'] },
    { ...good, effect: 'email' }, { ...good, effect: null },
    { ...good, permissions: ['root'] }, { ...good, permissions: 'tenant.read.leads' }, { ...good, permissions: ['net.fetch', 'net.fetch'] },
    { ...good, triggers: [] }, { ...good, triggers: [{ kind: 'cron' }] }, { ...good, triggers: [{ kind: 'enqueue', every: 1 }] },
    { ...good, input: { type: 'object' } }, { ...good, input: { type: 'string' } }, { ...good, input: { type: 'regex' } },
    { ...good, input: { type: 'object', properties: { __proto__x: { type: 'null' } } } }, { ...good, input: deep(MAX_DEPTH + 2) },
    { ...good, output: { type: 'object', properties: {}, required: ['missing'] } },
    { ...good, stateVersion: 0 }, { ...good, stateVersion: 1.5 }, { ...good, timeoutMs: 10 }, { ...good, timeoutMs: 10 ** 9 },
    { ...good, maxOutputBytes: 10 ** 9 }, { ...good, limits: { ...good.limits, maxInFlight: 0 } }, { ...good, limits: { ...good.limits, extra: 1 } },
    { ...good, limits: { maxInFlight: 1 } }, { ...good, limits: { ...good.limits, maxAttempts: '3' } },
  ]
  for (const d of bad) assert.notEqual(checkDefinition(d), null, JSON.stringify(d)?.slice(0, 80))
})

bothEngines('register: only a reviewed (name, version) whose hash matches its pin and its file; immutable; refusals recorded', async ({ db }) => {
  // unreviewed name, unknown version, wrong hash, and malformed values of every type: refused, nothing catalogued
  await refused(register(db, OP, { name: 'not-reviewed', version: '1.0.0', codeHash: 'a'.repeat(64) }, TEST_REGISTRY, NOW), 'unreviewed')
  await refused(register(db, OP, { name: 'echo', version: '9.9.9', codeHash: pin('echo', '1.0.0') }, TEST_REGISTRY, NOW), 'unreviewed')
  await refused(register(db, OP, { name: 'echo', version: '1.0.0', codeHash: pin('echo', '1.1.0') }, TEST_REGISTRY, NOW), 'hash_mismatch')
  for (const req of [
    { name: null, version: '1.0.0', codeHash: pin('echo', '1.0.0') }, { name: ['echo'], version: '1.0.0', codeHash: pin('echo', '1.0.0') },
    { name: { n: 'echo' }, version: '1.0.0', codeHash: pin('echo', '1.0.0') }, { name: 'echo', version: 1, codeHash: pin('echo', '1.0.0') },
    { name: 'echo', version: '1.0.0', codeHash: pin('echo', '1.0.0').toUpperCase() }, { name: 'echo', version: '1.0.0', codeHash: true },
    { name: 'echo\uD800', version: '1.0.0', codeHash: pin('echo', '1.0.0') }, { name: 'echo'.repeat(10_000), version: '1.0.0', codeHash: '' },
    { name: '../../etc/passwd', version: '1.0.0', codeHash: pin('echo', '1.0.0') },
  ]) await refused(register(db, OP, req, TEST_REGISTRY, NOW), 'bad_request')
  // a registry entry whose file no longer matches the pin (code changed after review): refused
  const e = TEST_REGISTRY.get('echo@1.0.0')!
  const tampered: Registry = new Map([['echo@1.0.0', { ...e, file: TEST_REGISTRY.get('echo@1.1.0')!.file }]])
  await refused(register(db, OP, { name: 'echo', version: '1.0.0', codeHash: e.sha256 }, tampered, NOW), 'hash_mismatch')
  const missing: Registry = new Map([['echo@1.0.0', { ...e, file: new URL('file:///nonexistent/echo.ts') }]])
  await refused(register(db, OP, { name: 'echo', version: '1.0.0', codeHash: e.sha256 }, missing, NOW), 'hash_mismatch')
  // a module whose exported definition disagrees with its registry key
  const liar: Registry = new Map([['echo@1.0.0', { ...e, module: TEST_REGISTRY.get('echo@1.1.0')!.module }]])
  await refused(register(db, OP, { name: 'echo', version: '1.0.0', codeHash: e.sha256 }, liar, NOW), 'bad_definition')
  // an unusable actor is refused and recorded as invalid-actor
  for (const actor of ['', 'a b', 'x'.repeat(81), null, 42]) await refused(register(db, actor as string, { name: 'echo', version: '1.0.0', codeHash: e.sha256 }, TEST_REGISTRY, NOW), 'bad_actor')
  assert.equal(Number((await db.get<{ c: number }>('SELECT count(*) AS c FROM worker_catalog'))!.c), 0)

  assert.deepEqual(await register(db, OP, { name: 'echo', version: '1.0.0', codeHash: e.sha256 }, TEST_REGISTRY, NOW), { created: true })
  assert.deepEqual(await register(db, OP, { name: 'echo', version: '1.0.0', codeHash: e.sha256 }, TEST_REGISTRY, NOW), { created: false })
  // same (name, version) under different reviewed code: immutable
  const other: Registry = new Map([['echo@1.0.0', { ...TEST_REGISTRY.get('echo@1.1.0')!, module: e.module }]])
  await refused(register(db, OP, { name: 'echo', version: '1.0.0', codeHash: pin('echo', '1.1.0') }, other, NOW), 'immutable')
  // the catalog row itself cannot be edited, and the trail cannot be edited or deleted
  await assert.rejects(db.run("UPDATE worker_catalog SET effect = 'send' WHERE name = 'echo'"))
  await assert.rejects(db.run("UPDATE worker_events SET decision = 'allowed'"))
  await assert.rejects(db.run('DELETE FROM worker_events'))

  const ev = await events(db, { limit: 1000 })
  const ok = ev.filter(x => x.decision === 'allowed')
  assert.deepEqual(ok.map(x => [x.actor, x.action, x.name, x.version, x.code_hash]), [[OP, 'register', 'echo', '1.0.0', e.sha256]])
  const denied = ev.filter(x => x.decision === 'denied')
  assert.equal(denied.length, 3 + 9 + 3 + 5 + 1)
  assert.equal(denied.filter(x => x.actor === 'invalid-actor').length, 5)
  assert.ok(denied.every(x => x.detail && x.detail.length <= 200))
})

bothEngines('start: registration grants nothing; send/spend effects and unprovided permissions never start', async ({ db }) => {
  await seed(db)
  for (const n of ['sender', 'spender', 'reader']) {
    await register(db, OP, { name: n, version: '1.0.0', codeHash: pin(n, '1.0.0') }, TEST_REGISTRY, NOW)
    await refused(start(db, OP, n, '1.0.0', NOW), 'unrunnable')
    assert.equal(await deployment(db, n), null)
    // a grant does not make it runnable either: the tenant's enqueue is unavailable, and writes nothing
    await grant(db, OP, A.tenantId, n, NOW)
    assert.deepEqual(await enqueueRun(db, A, n, {}, NOW), { ok: false, error: 'unavailable' })
  }
  await refused(start(db, OP, 'echo', '1.0.0', NOW), 'unknown') // not registered
  await refused(start(db, OP, 'echo', '1.0', NOW), 'bad_request')
  await deployEcho(db)
  await refused(start(db, OP, 'echo', '1.0.0', NOW), 'exists')
  // no grant, no runs: tenant B cannot use what A was granted
  assert.deepEqual(await enqueueRun(db, B, 'echo', { n: 1 }, NOW), { ok: false, error: 'unavailable' })
  // none of those four refusals (three unrunnable-but-granted, one not granted) left a run or a queue item
  assert.equal(Number((await db.get<{ c: number }>('SELECT count(*) AS c FROM worker_runs'))!.c), 0)
  assert.equal(Number((await db.get<{ c: number }>('SELECT count(*) AS c FROM work_queue'))!.c), 0)
  const ev = (await events(db)).filter(x => x.action === 'start' && x.decision === 'denied').map(x => x.detail)
  assert.deepEqual(ev.slice(0, 3), ['unrunnable: effect_requires_authority', 'unrunnable: effect_requires_authority', 'unrunnable: permission_unavailable'])
})

// What a tenant request can leave behind before an operator has registered, started and granted a worker: nothing.
// (#623 review: 1000 enqueues against no deployed worker used to leave 1000 'refused' worker_runs rows.)
const rowCounts = async (db: Db) => {
  const out: Record<string, number> = {}
  for (const t of ['worker_runs', 'work_queue', 'worker_events', 'worker_catalog', 'worker_deployments', 'worker_grants', 'audit_events']) {
    out[t] = Number((await db.get<{ c: number }>(`SELECT count(*) AS c FROM ${t}`))!.c)
  }
  return out
}
const BIG = { n: 1, pad: 'x'.repeat(100_000) }
const NAMES: unknown[] = [
  undefined, null, true, false, 0, 1, -1, 1.5, Number.NaN, Infinity, BigInt(10), ['echo'], [], {}, { name: 'echo' }, () => 'echo', Symbol('echo'),
  new String('echo'), '', ' ', 'echo ', ' echo', 'ECHO', 'Echo', 'e', 'x'.repeat(41), 'echo'.repeat(250_000), 'echo\u0000', 'echo\uD800', '\uFFFD\uFFFD',
  'ech\u00f6', '../echo', 'echo;DROP TABLE worker_runs', "echo' OR '1'='1", '__proto__', 'constructor', 'toString', 'worker:echo',
]
const INPUTS: unknown[] = [undefined, null, true, 1, 'x', [], [1], {}, { n: 1 }, BIG, { n: 1, tenantId: 'tenant-b' }]

bothEngines('not registered, not running, not granted: every enqueue answers unavailable and writes no row anywhere', async ({ db }) => {
  await seed(db)
  const empty = await rowCounts(db)
  // Instinct's repro: 500 unknown names and 500 'echo' enqueues with 100KB payloads, nothing registered
  for (let i = 0; i < 500; i++) assert.deepEqual(await enqueueRun(db, A, `unknown-${i}`, BIG, NOW), { ok: false, error: 'unavailable' })
  for (let i = 0; i < 500; i++) assert.deepEqual(await enqueueRun(db, A, 'echo', BIG, NOW), { ok: false, error: 'unavailable' })
  assert.deepEqual(await rowCounts(db), empty)
  // malformed names of every type, with inputs of every type, replayed: unavailable (never a throw), nothing written
  for (const name of NAMES) for (const input of INPUTS) for (let k = 0; k < 2; k++) {
    assert.deepEqual(await enqueueRun(db, A, name, input, NOW), { ok: false, error: 'unavailable' }, String(typeof name === 'string' ? name.slice(0, 40) : typeof name))
  }
  // concurrent: 200 at once, from two tenants
  const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => enqueueRun(db, i % 2 ? A : B, i % 3 ? 'echo' : `nope-${i}`, { n: i }, NOW)))
  assert.ok(rs.every(r => !r.ok && r.error === 'unavailable'))
  assert.deepEqual(await rowCounts(db), empty)

  // walk the operator steps; before the last one, a tenant still writes nothing
  const states: [string, () => Promise<unknown>][] = [
    ['registered, not started', () => register(db, OP, { name: 'echo', version: '1.0.0', codeHash: pin('echo', '1.0.0') }, TEST_REGISTRY, NOW)],
    ['running, not granted', () => start(db, OP, 'echo', '1.0.0', NOW)],
    ['running, granted to another tenant only', () => grant(db, OP, B.tenantId, 'echo', NOW)],
  ]
  for (const [label, step] of states) {
    await step()
    const before = await rowCounts(db)
    for (let i = 0; i < 50; i++) assert.deepEqual(await enqueueRun(db, A, 'echo', i % 2 ? BIG : { n: i }, NOW), { ok: false, error: 'unavailable' }, label)
    for (const input of INPUTS) assert.deepEqual(await enqueueRun(db, A, 'echo', input, NOW), { ok: false, error: 'unavailable' }, label)
    await Promise.all(Array.from({ length: 50 }, (_, i) => enqueueRun(db, A, 'echo', { n: i }, NOW)))
    assert.deepEqual(await rowCounts(db), before, label)
  }
  // granted to A, then not running (fenced stop, drained stop, crash-looped/failed): nothing written while not running
  await grant(db, OP, A.tenantId, 'echo', NOW)
  const stopped: [string, () => Promise<unknown>][] = [
    ['stopped (fence)', () => stop(db, OP, 'echo', { mode: 'fence' }, NOW)],
    ['stopped (drain)', async () => { await restart(db, OP, 'echo', NOW); await stop(db, OP, 'echo', {}, NOW) }],
    ['failed', () => db.run("UPDATE worker_deployments SET state = 'failed', restart_after = NULL WHERE name = 'echo'")],
  ]
  for (const [label, step] of stopped) {
    await step()
    const before = await rowCounts(db)
    for (const input of INPUTS) for (let k = 0; k < 3; k++) assert.deepEqual(await enqueueRun(db, A, 'echo', input, NOW), { ok: false, error: 'unavailable' }, label)
    assert.deepEqual(await rowCounts(db), before, label)
  }
  // granted to A but revoked: nothing written
  await restart(db, OP, 'echo', NOW)
  await revoke(db, OP, A.tenantId, 'echo', NOW)
  let before = await rowCounts(db)
  for (const input of INPUTS) assert.deepEqual(await enqueueRun(db, A, 'echo', input, NOW), { ok: false, error: 'unavailable' })
  assert.deepEqual(await rowCounts(db), before)
  // a deployment row pointing at a version that is not catalogued, or whose definition cannot run here (rows edited
  // behind the app's back), granted to A: still unavailable, nothing written
  await register(db, OP, { name: 'sender', version: '1.0.0', codeHash: pin('sender', '1.0.0') }, TEST_REGISTRY, NOW)
  await grant(db, OP, A.tenantId, 'sender', NOW)
  await db.run(`INSERT INTO worker_deployments (name, version, state, generation, max_in_flight, per_tenant_in_flight, max_backlog, max_attempts, updated_at, updated_by)
    VALUES ('sender', '1.0.0', 'running', 1, 1, 1, 10, 1, ?, 'test')`, [NOW])
  await grant(db, OP, A.tenantId, 'echo', NOW)
  await db.run("UPDATE worker_deployments SET version = '9.9.9' WHERE name = 'echo'")
  before = await rowCounts(db)
  for (const name of ['sender', 'echo']) for (const input of INPUTS) assert.deepEqual(await enqueueRun(db, A, name, input, NOW), { ok: false, error: 'unavailable' }, name)
  assert.deepEqual(await rowCounts(db), before)
  // an unknown role or a viewer: forbidden, nothing written
  for (const role of ['viewer', 'nope', null, 1]) assert.deepEqual(await enqueueRun(db, { ...A, role: role as RunUser['role'] }, 'echo', { n: 1 }, NOW), { ok: false, error: 'forbidden' })
  assert.deepEqual(await rowCounts(db), before)
  assert.equal(Number((await db.get<{ c: number }>('SELECT count(*) AS c FROM worker_runs'))!.c), 0)

  // only once running AND granted are refusals recorded: bad_input (input not stored), backlog
  await db.run("UPDATE worker_deployments SET version = '1.0.0' WHERE name = 'echo'")
  assert.equal((await enqueueRun(db, A, 'echo', { n: 1 }, NOW)).ok, true)
  const bad = await enqueueRun(db, A, 'echo', { n: 'secret-ish' }, NOW)
  assert.equal(bad.ok ? 'ok' : bad.error, 'bad_input')
  const runs = await db.all<{ tenant_id: string; status: string; input: string }>("SELECT tenant_id, status, input FROM worker_runs ORDER BY status")
  assert.deepEqual(runs.map(r => [r.tenant_id, r.status]), [[A.tenantId, 'queued'], [A.tenantId, 'refused']])
  assert.equal(runs[1].input, 'null')
})

bothEngines('grant: a real tenant only; written to the tenant audit trail; revoke closes it again', async ({ db }) => {
  await seed(db)
  await register(db, OP, { name: 'echo', version: '1.0.0', codeHash: pin('echo', '1.0.0') }, TEST_REGISTRY, NOW)
  await start(db, OP, 'echo', '1.0.0', NOW)
  await refused(grant(db, OP, 'no-such-tenant', 'echo', NOW), 'no_tenant')
  // a deleted tenant (tombstoned) cannot be granted anything, and the refusal is recorded
  await db.run('INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)', ['tenant-gone', 'gone@example.test', 'x', 'y'])
  await db.run("INSERT INTO tenant_tombstones (deleted_tenant, requested_at, requested_by, state, policy) VALUES ('tenant-gone', 1, 'test', 'requested', '{}')")
  await refused(grant(db, OP, 'tenant-gone', 'echo', NOW), 'no_tenant')
  for (const t of [null, 42, ['tenant-a'], { id: 'tenant-a' }, '', 'tenant a', "tenant-a' OR 1=1", 'x'.repeat(65)]) await refused(grant(db, OP, t, 'echo', NOW), 'bad_request')
  await refused(grant(db, OP, A.tenantId, 'not-registered', NOW), 'unknown')
  assert.deepEqual(await grant(db, OP, A.tenantId, 'echo', NOW), { created: true })
  assert.deepEqual(await grant(db, OP, A.tenantId, 'echo', NOW), { created: false })
  const audit = await db.all<{ tenant_id: string; actor_id: string; actor_kind: string; action: string; resource_id: string }>('SELECT tenant_id, actor_id, actor_kind, action, resource_id FROM audit_events')
  assert.deepEqual(audit, [{ tenant_id: A.tenantId, actor_id: OP, actor_kind: 'support', action: 'worker.grant', resource_id: 'echo' }])
  const r = await enqueueRun(db, A, 'echo', { n: 1 }, NOW)
  assert.equal(r.ok, true)
  assert.deepEqual(await revoke(db, OP, A.tenantId, 'echo', NOW), { removed: true })
  assert.deepEqual(await enqueueRun(db, A, 'echo', { n: 2 }, NOW), { ok: false, error: 'unavailable' })
})

bothEngines('enqueue: tenant from the session only, role-checked, input schema-checked; another tenant reads nothing', async ({ db }) => {
  await seed(db)
  await deployEcho(db)
  await grant(db, OP, B.tenantId, 'echo', NOW)
  assert.deepEqual(await enqueueRun(db, { ...A, role: 'viewer' }, 'echo', { n: 1 }, NOW), { ok: false, error: 'forbidden' })
  for (const name of [null, 1, ['echo'], {}, 'ECHO', '', 'x'.repeat(100)]) assert.deepEqual(await enqueueRun(db, A, name, { n: 1 }, NOW), { ok: false, error: 'unavailable' })
  const cyc: Record<string, unknown> = { n: 1 }; cyc.self = cyc
  let nest: unknown = { n: 1 }; for (let i = 0; i < 100; i++) nest = { n: 1, x: nest }
  const badInputs: unknown[] = [
    null, undefined, 1, 'n', [], [{ n: 1 }], {}, { n: '1' }, { n: 1.5 }, { n: -1 }, { n: Number.NaN }, { n: Infinity }, { n: 10 ** 9 },
    { n: 1, extra: true }, { n: 1, tenantId: B.tenantId }, { n: 1, sleepMs: 'long' }, { n: 2 ** 53 + 2 }, cyc, nest, new (class { n = 1 })(),
    Object.assign(Object.create({ inherited: 1 }), { n: 1 }), { n: 1, [Symbol('s')]: 1 },
  ]
  for (const input of badInputs) {
    const r = await enqueueRun(db, A, 'echo', input, NOW)
    assert.equal(r.ok, false); assert.equal((r as { error: string }).error, 'bad_input')
  }
  const ok = await enqueueRun(db, A, 'echo', { n: 7 }, NOW)
  assert.ok(ok.ok)
  const id = (ok as { id: string }).id
  // tenant B with tenant A's run id: not found; malformed ids: not found, never an error
  assert.equal(await getRun(db, B, id), null)
  for (const bad of [null, 1, [id], { id }, `${id}' OR '1'='1`, id.toUpperCase(), '']) assert.equal(await getRun(db, A, bad), null)
  const mine = await getRun(db, A, id)
  assert.deepEqual([mine?.status, mine?.name], ['queued', 'echo'])
  // the queue row and the run row both carry A's tenant, from the session; the input carries no tenant field
  assert.deepEqual(await db.get('SELECT tenant_id, kind FROM work_queue WHERE id = ?', [id]), { tenant_id: A.tenantId, kind: 'worker:echo' })
  const refusedN = Number((await db.get<{ c: number }>("SELECT count(*) AS c FROM worker_runs WHERE status = 'refused' AND error LIKE 'bad_input%'"))!.c)
  assert.equal(refusedN, badInputs.length)
  // the host runs it; B still sees nothing, A sees the output
  assert.equal(await host(db).tick(), 'done')
  assert.equal(await getRun(db, B, id), null)
  assert.ok((await listRuns(db, B)).every(r => r.id !== id))
  assert.ok((await listRuns(db, A)).some(r => r.id === id && r.status === 'done'))
  assert.deepEqual((await getRun(db, A, id))?.output, { n: 7, by: '1.0.0' })
})

bothEngines('admission: per-tenant backlog from the deployment row; a full tenant does not block another', async ({ db }) => {
  await seed(db)
  await deployEcho(db)
  await grant(db, OP, B.tenantId, 'echo', NOW)
  await refused(setLimits(db, OP, 'echo', { maxBacklog: 0 }, NOW), 'bad_limits')
  for (const l of [null, [], {}, { maxBacklog: '2' }, { maxBacklog: 2.5 }, { maxBacklog: 10 ** 6 }, { other: 1 }, { maxInFlight: -1 }]) await refused(setLimits(db, OP, 'echo', l, NOW), 'bad_limits')
  await refused(setLimits(db, OP, 'nope', { maxBacklog: 2 }, NOW), 'not_deployed')
  await setLimits(db, OP, 'echo', { maxBacklog: 2 }, NOW)
  const rs = []
  for (let i = 0; i < 3; i++) rs.push(await enqueueRun(db, A, 'echo', { n: i }, NOW))
  assert.deepEqual(rs.map(r => r.ok ? 'ok' : r.error), ['ok', 'ok', 'backlog'])
  assert.equal((await enqueueRun(db, B, 'echo', { n: 1 }, NOW)).ok, true)
  assert.equal(Number((await db.get<{ c: number }>("SELECT count(*) AS c FROM worker_runs WHERE status = 'refused' AND error = 'backlog'"))!.c), 1)
})

bothEngines('hostile handler output: never written as a result; recorded as the run error', async ({ db }) => {
  await seed(db)
  await register(db, OP, { name: 'hostile', version: '1.0.0', codeHash: pin('hostile', '1.0.0') }, TEST_REGISTRY, NOW)
  await start(db, OP, 'hostile', '1.0.0', NOW)
  await grant(db, OP, A.tenantId, 'hostile', NOW)
  const want: Record<string, string> = {
    ok: 'done', extra: 'output_schema', class: 'output_schema', bigint: 'output_schema', huge: 'output_too_large', fn: 'output_schema',
    cycle: 'output_schema', undefined: 'output_schema', array: 'output_schema', surrogate: 'output_schema', hang: 'timeout',
    'throw-weird': 'handler_error', 'throw-null': 'handler_error', reject: 'handler_error',
  }
  // one at a time, so a crash loop (5 faults in a row) is not what is measured here
  for (const [mode, expect] of Object.entries(want)) {
    const r = await enqueueRun(db, A, 'hostile', { mode }, NOW)
    assert.ok(r.ok, mode)
    await restart(db, OP, 'hostile', NOW)
    const out = await host(db).tick()
    const run = (await getRun(db, A, (r as { id: string }).id))!
    if (expect === 'done') { assert.equal(out, 'done'); assert.deepEqual(run.output, { ok: true }); continue }
    assert.equal(out, 'failed', mode)
    assert.equal(run.status, 'failed', mode)
    assert.equal(run.output, null, mode)
    assert.ok(run.error?.startsWith(expect), `${mode}: ${run.error}`)
    assert.ok(!run.error?.includes('example.com') && !run.error?.includes('toString'), run.error!)
  }
})

bothEngines('crash loop: stopped after repeated faults, restarted with backoff a bounded number of times, then left for an operator', async ({ db }) => {
  await seed(db)
  await register(db, OP, { name: 'flaky', version: '1.0.0', codeHash: pin('flaky', '1.0.0') }, TEST_REGISTRY, NOW)
  await start(db, OP, 'flaky', '1.0.0', NOW)
  await grant(db, OP, A.tenantId, 'flaky', NOW)
  let now = NOW
  const h = new WorkerHost(db, { registry: TEST_REGISTRY, instance: 't', backoff: { baseSeconds: 10, factor: 2, jitter: 0 }, clock: () => now })
  const gaps: number[] = []
  for (let round = 0; round <= MAX_AUTO_RESTARTS; round++) {
    for (let i = 0; i < CRASH_LOOP_FAILURES; i++) {
      assert.equal((await enqueueRun(db, A, 'flaky', { n: i }, now)).ok, true)
      assert.equal(await h.tick(), 'failed')
    }
    const d = (await deployment(db, 'flaky'))!
    assert.equal(d.state, 'failed')
    assert.equal(d.restarts, round)
    // nothing more runs while failed; the queued item waits
    await enqueueRun(db, A, 'flaky', { n: 99 }, now).then(r => assert.deepEqual(r, { ok: false, error: 'unavailable' }))
    if (round === MAX_AUTO_RESTARTS) { assert.equal(d.restartAfter, null); break }
    gaps.push(d.restartAfter! - now)
    now = d.restartAfter! - 1
    assert.equal(await h.tick(), null) // backoff not over
    assert.equal((await deployment(db, 'flaky'))!.state, 'failed')
    now += 1
    assert.equal(await h.tick(), null) // restarted (nothing queued)
    assert.equal((await deployment(db, 'flaky'))!.state, 'running')
  }
  assert.deepEqual(gaps, [10, 20, 40])
  now += 10 ** 6
  assert.equal(await h.tick(), null)
  assert.equal((await deployment(db, 'flaky'))!.state, 'failed') // restarts used up: stays failed
  const r = await restart(db, OP, 'flaky', now)
  assert.deepEqual([r.state, r.restarts, r.failures], ['running', 0, 0])
  const acts = (await events(db, { name: 'flaky' })).map(e => e.action)
  assert.equal(acts.filter(a => a === 'crash_loop').length, MAX_AUTO_RESTARTS + 1)
  assert.equal(acts.filter(a => a === 'auto_restart').length, MAX_AUTO_RESTARTS)
})

bothEngines('host: a deployment whose registered hash differs from this build is refused, recorded once, never claimed', async ({ db }) => {
  await seed(db)
  await deployEcho(db)
  const r = await enqueueRun(db, A, 'echo', { n: 1 }, NOW)
  const e = TEST_REGISTRY.get('echo@1.0.0')!
  const otherBuild: Registry = new Map([['echo@1.0.0', { ...e, sha256: pin('echo', '1.1.0'), file: TEST_REGISTRY.get('echo@1.1.0')!.file }]])
  const h = host(db, otherBuild)
  assert.equal(await h.tick(), null)
  assert.equal(await h.tick(), null)
  const noBuild = host(db, new Map())
  assert.equal(await noBuild.tick(), null)
  const ev = (await events(db)).filter(x => x.action === 'host_refused')
  assert.deepEqual(ev.map(x => x.detail), ['hash_mismatch', 'not in this build'])
  assert.equal((await getRun(db, A, (r as { id: string }).id))!.status, 'queued')
  assert.equal(await host(db).tick(), 'done')
})

bothEngines('lifecycle refusals: unknown, wrong direction, incompatible state, bad modes', async ({ db }) => {
  await seed(db)
  await refused(stop(db, OP, 'echo', {}, NOW), 'not_deployed')
  await refused(restart(db, OP, 'echo', NOW), 'not_deployed')
  await deployEcho(db)
  for (const o of [{ mode: 'kill' }, { mode: null }, { drainSeconds: 0 }, { drainSeconds: '5' }, { drainSeconds: 10 ** 6 }]) await refused(stop(db, OP, 'echo', o, NOW), 'bad_request')
  await refused(activate(db, OP, 'echo', '1.1.0', 'upgrade', NOW), 'unknown')
  await register(db, OP, { name: 'echo', version: '1.1.0', codeHash: pin('echo', '1.1.0') }, TEST_REGISTRY, NOW)
  await register(db, OP, { name: 'echo', version: '2.0.0', codeHash: pin('echo', '2.0.0') }, TEST_REGISTRY, NOW)
  await refused(activate(db, OP, 'echo', '1.1.0', 'rollback', NOW), 'not_older')
  await refused(activate(db, OP, 'echo', '1.0.0', 'upgrade', NOW), 'not_newer')
  await refused(activate(db, OP, 'echo', '2.0.0', 'upgrade', NOW), 'incompatible_state')
  await refused(activate(db, OP, 'echo', 'latest', 'upgrade', NOW), 'bad_request')
  const up = await activate(db, OP, 'echo', '1.1.0', 'upgrade', NOW)
  assert.deepEqual([up.version, up.generation], ['1.1.0', 2])
  const back = await activate(db, OP, 'echo', '1.0.0', 'rollback', NOW)
  assert.deepEqual([back.version, back.generation], ['1.0.0', 3])
  const ev = (await events(db, { name: 'echo' })).filter(e => e.decision === 'allowed').map(e => [e.action, e.version, e.generation])
  assert.deepEqual(ev.slice(-2), [['upgrade', '1.1.0', 2], ['rollback', '1.0.0', 3]])
})

bothEngines('a claim taken after a fence (the host read the old generation first) cannot commit: requeued, nothing written', async ({ db }) => {
  await seed(db)
  await deployEcho(db)
  const r = await enqueueRun(db, A, 'echo', { n: 3 }, NOW)
  const old = (await deployment(db, 'echo'))!
  // the race: the operator fences between the host reading the deployment and the host claiming
  await stop(db, OP, 'echo', { mode: 'fence' }, NOW)
  await restart(db, OP, 'echo', NOW)
  const claim = (await new DbQueue(db).claim({ kinds: ['worker:echo'], now: NOW }))!
  assert.ok(claim)
  const h = host(db)
  const entry = TEST_REGISTRY.get('echo@1.0.0')!
  const c = { claim, dep: old, def: entry.module.definition, entry }
  assert.equal(await h.finish(c, await h.execute(c)), 'stale')
  assert.deepEqual(await db.get('SELECT status, claim_token FROM work_queue WHERE id = ?', [claim.item.id]), { status: 'pending', claim_token: null })
  assert.deepEqual([(await getRun(db, A, (r as { id: string }).id))!.status, (await getRun(db, A, (r as { id: string }).id))!.output], ['queued', null])
  // under the current generation it runs normally
  assert.equal(await h.tick(), 'done')
  assert.equal((await getRun(db, A, (r as { id: string }).id))!.status, 'done')
})
