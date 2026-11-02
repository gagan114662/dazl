// Adversarial probes for PR #455 on Postgres: concurrency between a tenant deletion and other transactions, and the
// store copy (backup / engine move) path. Adopted from the council's attack review as regression tests (the first two
// were its finding on 97898162: an in-flight writer survived a completed deletion; fixed by the per-step locks).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pgDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { copyStore } from '../lib/db/copy-store.ts'
import { closingEventTx, deleteTenant, tombstone } from '../lib/tenant/lifecycle.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'
import { seedTenant, snapshot } from './helpers/tenant-seed.ts'
import { seedTenantSqlite } from './helpers/tenant-seed-sqlite.ts'

const A = 'race-tenant-aaaa', B = 'race-tenant-bbbb', NOW = 1_900_000_000, BY = 'operator (attack probe)'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const n = async (db: Db, sql: string, params: unknown[] = []) => Number((await db.get<{ n: number }>(sql, params as never))?.n)

async function pgFixture() {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  await runPgMigrations(db.pool)
  for (const [id, tag] of [[A, 'ra'], [B, 'rb']]) {
    await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y')", [id, `${tag}@example.test`])
    const r = await seedTenant(db, id, tag); assert.deepEqual(r.failed, {})
    await db.run("UPDATE memberships SET member_id = ?, role = 'owner' WHERE tenant_id = ?", [id, id])
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1) ON CONFLICT (id) DO NOTHING", [id, `${id} workspace`, id])
  }
  // a second, raw connection for a transaction that straddles the deletion
  const other = new pg.Client({ connectionString: PG_URL!, options: `-c search_path=${s.schema}` })
  await other.connect()
  const ids = async (t: string) => (await db.get<{ id: string }>('SELECT id FROM scan_jobs WHERE user_id = ?', [t]))!.id
  return { db, other, s, ids, close: async () => { await other.end().catch(() => {}); await db.close(); await s.drop() } }
}

// Runs the deletion; reports whether it blocked (did not settle within `ms`).
async function deletionWhile(db: Db, ms = 1500) {
  let settled = false
  const p = deleteTenant(db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW }).finally(() => { settled = true })
  p.catch(() => {})
  await sleep(ms)
  return { p, blocked: !settled }
}

// CLAIM (docs): "from the moment the tombstone is written no write can add rows for the tenant"; brief: the deletion
// completing while another transaction inserts a row for that tenant must refuse or roll back one of them.
test('pg race: a transaction that inserted a row for A before the tombstone and commits after the deletion completed', { skip: pgSkip }, async () => {
  const f = await pgFixture()
  try {
    await f.other.query('BEGIN')
    await f.other.query("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('straddle-scan', $1, 'x', 'y', 'z')", [A])
    const d = await deletionWhile(f.db)
    console.log(`[pg] straddling INSERT scan_jobs: deletion blocked on the open transaction: ${d.blocked}`)
    let commit = 'committed'
    try { await f.other.query('COMMIT') } catch (e) { commit = `rolled back: ${(e as Error).message}` }
    const t = await d.p.catch(e => ({ state: `threw: ${(e as Error).message}` }))
    console.log(`[pg] straddling INSERT: other tx ${commit}; deletion -> ${t.state}`)
    const left = await n(f.db, 'SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [A])
    const again = await deleteTenant(f.db, A).catch(e => ({ state: `threw: ${(e as Error).message}` }))
    console.log(`[pg] straddling INSERT: re-running the deletion -> ${again.state}; scan_jobs of A now: ${await n(f.db, 'SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [A])}`)
    assert.equal(left, 0, `rows of the deleted tenant after both finished (deletion ${t.state}, other tx ${commit}): ${left}`)
  } finally { await f.close() }
})

test('pg race: a transaction that moved B\'s row under A before the tombstone and commits after the deletion completed', { skip: pgSkip }, async () => {
  const f = await pgFixture()
  try {
    const bBefore = await snapshot(f.db, B)
    await f.other.query('BEGIN')
    await f.other.query('UPDATE suppressions SET tenant_id = $1 WHERE tenant_id = $2', [A, B])
    const d = await deletionWhile(f.db)
    console.log(`[pg] straddling UPDATE move: deletion blocked: ${d.blocked}`)
    let commit = 'committed'
    try { await f.other.query('COMMIT') } catch (e) { commit = `rolled back: ${(e as Error).message}` }
    const t = await d.p.catch(e => ({ state: `threw: ${(e as Error).message}` }))
    const aRows = await n(f.db, 'SELECT count(*) AS n FROM suppressions WHERE tenant_id = ?', [A])
    const bRows = await n(f.db, 'SELECT count(*) AS n FROM suppressions WHERE tenant_id = ?', [B])
    console.log(`[pg] straddling UPDATE move: other tx ${commit}; deletion -> ${t.state}; suppressions A=${aRows} B=${bRows}`)
    assert.equal(aRows, 0, `a row owned by the deleted tenant after completion (other tx ${commit})`)
    if (commit === 'committed') assert.notDeepEqual(await snapshot(f.db, B), bBefore, 'B lost its row to A (recorded)')
  } finally { await f.close() }
})

test('pg race: a child row (lead, FK CASCADE) inserted under A\'s running scan before the tombstone, committed after the deletion', { skip: pgSkip }, async () => {
  const f = await pgFixture()
  try {
    await f.db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('a-running', ?, 'x', 'y', 'z', 'running')", [A])
    await f.other.query('BEGIN')
    const bLead = (await f.other.query('SELECT * FROM leads WHERE scan_job_id = $1', [await f.ids(B)])).rows[0] as Record<string, unknown>
    const lc = Object.keys(bLead); const lv = lc.map(k => k === 'id' ? 'straddle-lead' : k === 'scan_job_id' ? 'a-running' : bLead[k])
    await f.other.query(`INSERT INTO leads (${lc.map(k => `"${k}"`).join(', ')}) VALUES (${lc.map((_, i) => `$${i + 1}`).join(', ')})`, lv)
    const d = await deletionWhile(f.db)
    console.log(`[pg] straddling child INSERT: deletion blocked: ${d.blocked}`)
    let commit = 'committed'
    try { await f.other.query('COMMIT') } catch (e) { commit = `rolled back: ${(e as Error).message}` }
    const t = await d.p.catch(e => ({ state: `threw: ${(e as Error).message}` }))
    console.log(`[pg] straddling child INSERT: other tx ${commit}; deletion -> ${t.state}`)
    assert.equal(await n(f.db, "SELECT count(*) AS n FROM leads WHERE id = 'straddle-lead'"), 0, 'the late lead must not survive')
    assert.equal(await n(f.db, 'SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [A]), 0)
    assert.equal((await tombstone(f.db, A))?.state, 'completed')
  } finally { await f.close() }
})

test('pg race: two deletions of A at once: exactly one tombstone, final state completed, B byte-identical, the loser fails with the state message', { skip: pgSkip }, async () => {
  const f = await pgFixture()
  const db2 = pgDb({ connectionString: PG_URL!, searchPath: f.s.schema })
  try {
    const bBefore = await snapshot(f.db, B)
    const r = await Promise.allSettled([
      deleteTenant(f.db, A, { policy: { suppressions: 'retain' }, requestedBy: 'first', now: NOW }),
      deleteTenant(db2, A, { policy: { suppressions: 'erase' }, requestedBy: 'second', now: NOW + 1 }),
    ])
    const errs = r.filter(x => x.status === 'rejected').map(x => (x as PromiseRejectedResult).reason.message)
    console.log(`[pg] concurrent deletions: ${r.map(x => x.status).join(', ')}; errors: ${errs.join(' | ') || 'none'}`)
    for (const e of errs) assert.match(e, /another run moved it|duplicate key/, e)
    const t = (await tombstone(f.db, A))!
    assert.equal(await n(f.db, 'SELECT count(*) AS n FROM tenant_tombstones WHERE deleted_tenant = ?', [A]), 1)
    // the loser must not have widened/narrowed the policy: whichever won is recorded consistently with what was kept
    const final = (await deleteTenant(f.db, A)).state
    assert.equal(final, 'completed')
    const kept = await n(f.db, 'SELECT count(*) AS n FROM suppressions WHERE tenant_id = ?', [A])
    assert.equal(kept, JSON.parse(t.policy).suppressions === 'retain' ? 1 : 0, `policy ${t.policy} vs retained suppressions ${kept}`)
    assert.deepEqual(await snapshot(f.db, B), bBefore)
  } finally { await db2.close(); await f.close() }
})

test('pg race: a deletion racing 150 autocommit inserts for A: every insert either landed before the tombstone and was erased, or was refused; none survives', { skip: pgSkip }, async () => {
  const f = await pgFixture()
  const db2 = pgDb({ connectionString: PG_URL!, searchPath: f.s.schema, max: 8 })
  try {
    const outcomes: string[] = []
    const writers = (async () => {
      for (let i = 0; i < 150; i++) {
        try { await db2.run('INSERT INTO suppressions (tenant_id, email, reason) VALUES (?, ?, ?)', [A, `race${i}@example.test`, 'manual']); outcomes.push('ok') }
        catch (e) { outcomes.push(/tenant deleted/.test((e as Error).message) ? 'refused' : `other: ${(e as Error).message}`) }
      }
    })()
    await sleep(30)
    const t = await deleteTenant(f.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW })
    await writers
    const counts = outcomes.reduce<Record<string, number>>((m, o) => ({ ...m, [o]: (m[o] ?? 0) + 1 }), {})
    console.log(`[pg] deletion vs inserts: deletion ${t.state}; insert outcomes ${JSON.stringify(counts)}`)
    assert.ok(!Object.keys(counts).some(k => k.startsWith('other')), 'no unexpected error')
    assert.equal(await n(f.db, 'SELECT count(*) AS n FROM suppressions WHERE tenant_id = ?', [A]), 0, 'no suppression of A survives')
  } finally { await db2.close(); await f.close() }
})

// CLAIM (copy-store): the copy disables the guard triggers for the copy and re-enables them. A store with a completed
// deletion that retained suppressions holds rows for a tombstoned tenant: the copy must take them, and the target must
// refuse new rows for A afterwards.
test('pg copy-store: SQLite store with a completed deletion (suppressions retained) copies into Postgres; guards are live on the target afterwards', { skip: pgSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe455-'))
  const raw = new Database(join(dir, 'src.db')); migrateAllSqlite(raw)
  const src = sqliteDb(raw)
  const s = await freshSchema()
  const dst = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    for (const [t, tag] of [[A, 'ca'], [B, 'cb']]) {
      const r = seedTenantSqlite(raw, t, tag); assert.deepEqual(r.failed, {})
      raw.prepare("UPDATE memberships SET member_id = ?, role = 'owner' WHERE tenant_id = ?").run(t, t)
      raw.prepare("INSERT OR IGNORE INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1)").run(t, `${t} workspace`, t)
    }
    const t = await deleteTenant(src, A, { policy: { suppressions: 'retain' }, requestedBy: BY, now: NOW })
    assert.equal(t.state, 'completed')
    await runPgMigrations(dst.pool)
    const report = await copyStore(src, dst)
    const tomb = report.tables.find(x => x.table === 'tenant_tombstones')
    const keys = report.tables.find(x => x.table === 'tenant_tombstone_keys')
    console.log(`[pg] copy-store: ${report.tables.length} tables; tombstones copied=${tomb?.rows}, keys copied=${keys?.rows}, skipped=${report.skipped.join(',') || 'none'}`)
    assert.equal(tomb?.rows, 1, 'the tombstone travels with the store')
    assert.ok((keys?.rows ?? 0) >= 1, 'the deleted parent keys travel with the store')
    assert.equal(await n(dst, 'SELECT count(*) AS n FROM suppressions WHERE tenant_id = ?', [A]), 1, 'retained rows copied despite the guard')
    assert.equal((await tombstone(dst, A))?.state, 'completed')
    // guards live again on the target
    await assert.rejects(dst.run("INSERT INTO suppressions (tenant_id, email, reason) VALUES (?, 'x@example.test', 'manual')", [A]), /tenant deleted/)
    await assert.rejects(dst.run('UPDATE tenant_memory SET tenant_id = ? WHERE tenant_id = ?', [A, B]), /tenant deleted/)
    await assert.rejects(dst.run("INSERT INTO leads (id, scan_job_id, company, source_url) VALUES ('late', ?, 'x', 'https://x.example.test')", [(await src.get<{ key: string }>("SELECT key FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND deleted_tenant = ?", [A]))!.key]), /tenant deleted|running job/)
    await dst.run("INSERT INTO suppressions (tenant_id, email, reason) VALUES (?, 'ok@example.test', 'manual')", [B])
    // re-applying the deletion on the copy is a no-op
    assert.equal((await deleteTenant(dst, A)).state, 'completed')
    assert.equal(await n(dst, 'SELECT count(*) AS n FROM suppressions WHERE tenant_id = ?', [A]), 1)
  } finally { await dst.close(); await s.drop(); await src.close(); rmSync(dir, { recursive: true, force: true }) }
})

// SQLite counterpart of the straddling race: a second connection to the same file holds an open write transaction.
test('sqlite race: a second connection with an uncommitted insert for A while the deletion runs: SQLite serialises (busy) rather than letting both commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe455s-'))
  const path = join(dir, 'race.db')
  const raw = new Database(path); migrateAllSqlite(raw)
  const other = new Database(path, { timeout: 200 })
  const db = sqliteDb(raw)
  try {
    for (const [t, tag] of [[A, 'sa'], [B, 'sb']]) {
      const r = seedTenantSqlite(raw, t, tag); assert.deepEqual(r.failed, {})
      raw.prepare("UPDATE memberships SET member_id = ?, role = 'owner' WHERE tenant_id = ?").run(t, t)
      raw.prepare("INSERT OR IGNORE INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1)").run(t, `${t} workspace`, t)
    }
    raw.pragma('busy_timeout = 200')
    other.exec('BEGIN')
    other.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('straddle-scan', ?, 'x', 'y', 'z')").run(A)
    let outcome = 'completed'
    try { await deleteTenant(db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW }) } catch (e) { outcome = (e as Error).message }
    console.log(`[sqlite] straddling INSERT: deletion -> ${outcome}`)
    other.exec('COMMIT')
    const t = await deleteTenant(db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW })
    assert.equal(t.state, 'completed')
    assert.equal((raw.prepare('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?').get(A) as { n: number }).n, 0, 'no scan of A survives')
  } finally { other.close(); await db.close(); rmSync(dir, { recursive: true, force: true }) }
})

// AB-BA regression for the CI test-postgres deadlock on 32290eee (job 125193518245): the deletion request
// transaction once wrote its closing event as gate -> event, while a deletion step runs advisory -> gate -> event,
// so two concurrent deletions of one tenant could deadlock (request held the audit_closing_gate row wanting the
// audit guard's shared advisory lock; the step held the advisory lock wanting the request's uncommitted gate row).
// closingEventTx now takes the tenant advisory lock before the gate in every caller. This test forces exactly that
// interleaving: the step side holds the exclusive advisory and waits until the request side is queued on it before
// writing its own closing event. Pre-fix the request already holds the gate row at that point, so the step's gate
// insert deadlocks against it (Postgres aborts one side); post-fix the request waits on the advisory holding
// nothing, the step completes, and both sides commit.
test('pg lock order: a closing event never holds the gate row before the tenant advisory (AB-BA regression)', { skip: pgSkip }, async () => {
  const f = await pgFixture()
  const step = new pg.Client({ connectionString: PG_URL!, options: `-c search_path=${f.s.schema}` })
  const db2 = pgDb({ connectionString: PG_URL!, searchPath: f.s.schema })
  try {
    await f.db.run("INSERT INTO tenant_tombstones (deleted_tenant, requested_at, requested_by, state, policy) VALUES (?, 1, 'operator (lock-order probe)', 'requested', '{}')", [A])
    await step.connect()
    await step.query('BEGIN')
    // the step side: a deletion step already holds the tenant's advisory lock before closingEventTx
    await step.query('SELECT pg_advisory_xact_lock(hashtext($1))', [A])
    // the request side: the real closingEventTx, as the request transaction runs it
    const req = db2.tx(function* (tx) { yield* closingEventTx(tx, A, 'operator (lock-order probe)', 'tenant.deletion_requested', NOW) })
    let queued = false
    for (let i = 0; i < 200 && !queued; i++) {
      await sleep(25)
      // scoped to this tenant's advisory key in this database, so an unrelated advisory wait (another test running
      // concurrently in CI) cannot trip it early and weaken the interleaving; objid is unsigned oid, hashtext is
      // signed int4 - mask to 32 bits so a negative hash still matches
      queued = (await n(f.db, "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = 0 AND objsubid = 1 AND objid::bigint = (hashtext(?)::bigint & 4294967295)", [A])) > 0
    }
    assert.ok(queued, 'the request side never queued on the tenant advisory lock')
    // the step finishes its closing event (same statements as closingEventTx, explicit so the interleaving is forced)
    await step.query('INSERT INTO audit_closing_gate (tenant) VALUES ($1)', [A])
    await step.query(`INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, resource_id, decision, summary, correlation_id, at, seq)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, (SELECT coalesce(max(seq), 0) + 1 FROM audit_events))`,
      ['lockorderevt1', A, 'operator (lock-order probe)', 'service', 'tenant.deletion_erased', 'tenant', A, 'allowed', '{}', null, NOW])
    await step.query('DELETE FROM audit_closing_gate WHERE tenant = $1', [A])
    await step.query('COMMIT')
    await req
    const acts = (await f.db.all<{ action: string }>("SELECT action FROM audit_events WHERE tenant_id = ? AND action LIKE 'tenant.deletion_%' ORDER BY seq", [A])).map(r => r.action)
    assert.deepEqual(acts, ['tenant.deletion_erased', 'tenant.deletion_requested'], 'both closing events committed, step first')
  } finally { await step.end().catch(() => {}); await db2.close(); await f.close() }
})

// The request transaction's closing event waits on the tenant's advisory lock (closingEventTx): the wait is bounded
// by lockTimeoutMs like a step's, and a timeout rolls the request back whole - no tombstone, gate row, event or
// partial change survives, and a retry once the holder releases succeeds.
test('pg request timeout: a hung writer makes the request give up with nothing changed, retry works', { skip: pgSkip }, async () => {
  const f = await pgFixture()
  const holder = new pg.Client({ connectionString: PG_URL!, options: `-c search_path=${f.s.schema}` })
  try {
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [A])
    await assert.rejects(
      deleteTenant(f.db, A, { policy: { suppressions: 'retain' }, requestedBy: 'operator (timeout probe)', lockTimeoutMs: 300, now: NOW }),
      /tenant deletion: the request waited 300 ms for in-flight writes of this tenant and gave up; nothing changed, retry/)
    assert.equal(await tombstone(f.db, A), undefined, 'no tombstone may survive the rolled-back request')
    assert.equal(await n(f.db, 'SELECT count(*) AS n FROM audit_closing_gate'), 0, 'no gate row at rest')
    assert.equal(await n(f.db, "SELECT count(*) AS n FROM audit_events WHERE tenant_id = ? AND action LIKE 'tenant.deletion_%'", [A]), 0, 'no closing event survived')
    assert.equal(await n(f.db, 'SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [A]) > 0, true, 'tenant data untouched')
    await holder.query('COMMIT')
    const t = await deleteTenant(f.db, A, { policy: { suppressions: 'retain' }, requestedBy: 'operator (timeout probe)', now: NOW, until: 'requested' })
    assert.equal(t.state, 'requested', 'the retry records the deletion once the holder releases')
    assert.equal(await n(f.db, "SELECT count(*) AS n FROM audit_events WHERE tenant_id = ? AND action = 'tenant.deletion_requested'", [A]), 1)
  } finally { await holder.end().catch(() => {}); await f.close() }
})
