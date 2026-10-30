// Tenant export and deletion (lib/tenant/lifecycle.ts, issue #359) on SQLite, today's production store, with synthetic
// data in EVERY tenant-scoped table for two tenants (test/helpers/tenant-seed-sqlite.ts). Proves: the export holds every
// table's rows for the target and nothing of the other tenant, with credentials redacted; deletion erases only the
// target (the other tenant byte-identical), keeps only what the policy retains, refuses to run without a decision on
// opt-outs; nothing can recreate the deleted tenant's data (late inserts, an in-flight scan finishing); a failed step
// rolls back and resumes; a restored backup re-applies the deletion from the off-database ledger.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { createQueryJob, finishJob } from '../lib/scan/store-db.ts'
import { deleteTenant, exportTenant, reapplyTombstones, retentionProblems, tenantScope, tombstone, tombstoneLedgerEntry, EXPORT_EXCLUDED } from '../lib/tenant/lifecycle.ts'
import { marker, seedTenantSqlite, snapshotSqlite, tenantTablesSqlite } from './helpers/tenant-seed-sqlite.ts'

const A = 'tenant-aaaa', B = 'tenant-bbbb', NOW = 1_900_000_000
const T = mkdtempSync(path.join(tmpdir(), 'tenant-lifecycle-'))
test.after(() => rmSync(T, { recursive: true, force: true }))
function fixture(file = ':memory:') {
  const db = new Database(file); migrateAllSqlite(db)
  for (const [t, tag] of [[A, 'ta'], [B, 'tb']]) { const s = seedTenantSqlite(db, t, tag); assert.deepEqual(s.failed, {}, `every tenant table seeded for ${t}`) }
  // each tenant is a personal workspace (lib/workspaces.ts): its organizations row, its founder as the sole owner
  for (const t of [A, B]) {
    db.prepare("UPDATE memberships SET member_id = ?, role = 'owner' WHERE tenant_id = ?").run(t, t)
    db.prepare("INSERT OR IGNORE INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1)").run(t, `${t} workspace`, t)
  }
  db.prepare('UPDATE tenant_llm_keys SET ciphertext = ? WHERE tenant_id = ?').run('SECRET-CIPHERTEXT-OF-A', A)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('SECRET-HASH-OF-A', A)
  return db
}
const POLICY = { suppressions: 'retain' as const }
// Every table, scanned by content rather than by ownership: a child row left behind after its parent was deleted
// (an orphan) is no longer reachable through the parent chain, but still carries the tenant's marker.
function leftovers(db: Database.Database, tag: string, keep: string[]): string[] {
  const out: string[] = []
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    if ([...keep, 'evidence_purge_audit'].includes(name)) continue
    for (const r of db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) if (Object.values(r).some(v => typeof v === 'string' && v.startsWith(`${tag}~`))) { out.push(name); break }
  }
  return out
}
// evidence_purge_audit is always kept (append-only audit, ALWAYS_RETAINED)
const emptyExcept = (snap: Record<string, string>, keep: string[]) => Object.entries(snap).filter(([t, rows]) => ![...keep, 'evidence_purge_audit'].includes(t) && rows !== '[]').map(([t]) => t)

test('the registry covers the live schema: every tenant-scoped table is in scope (every one seeded for each tenant)', async () => {
  const db = fixture()
  const scope = (await tenantScope(sqliteDb(db))).map(s => s.table).sort()
  assert.deepEqual(scope, [...tenantTablesSqlite(db).keys()].sort())
  assert.ok(scope.length >= 70, `${scope.length} tables`)
})

test('export: every table the tenant has rows in, nothing of the other tenant, credentials redacted, session state left out', async () => {
  const db = fixture()
  const e = await exportTenant(sqliteDb(db), A, new Date(NOW * 1000))
  const want = [...tenantTablesSqlite(db).keys()].filter(t => !EXPORT_EXCLUDED[t])
  for (const t of want) assert.ok(e.tables[t]?.length, `export has ${t}`)
  assert.ok(e.tables.users?.length === 1)
  for (const t of Object.keys(EXPORT_EXCLUDED)) assert.equal(e.tables[t], undefined, `${t} left out`)
  const json = JSON.stringify(e)
  assert.ok(!json.includes('tb~'), 'nothing of the other tenant')
  for (const secret of ['SECRET-CIPHERTEXT-OF-A', 'SECRET-HASH-OF-A']) assert.ok(!json.includes(secret), `${secret} not exported`)
  for (const c of ['tenant_llm_keys.ciphertext', 'users.password_hash', 'users.salt', 'gmail_accounts.refresh_ct']) assert.ok(e.redacted_columns.includes(c), c)
  assert.ok(json.includes(marker('ta', 'leads')) && json.includes(marker('ta', 'lead_sources')), 'parent-scoped rows included')
})

test('deletion: refuses without a decision on opt-outs; erases only the target; the other tenant is byte-identical; retained rows recorded', async () => {
  const db = fixture(), d = sqliteDb(db)
  await assert.rejects(deleteTenant(d, A, { requestedBy: 'test' }), /must decide suppressions/)
  await assert.rejects(deleteTenant(d, A, { requestedBy: 'test', policy: { suppressions: 'retain', retainTables: ['gmail_accounts'] } }), /holds credentials/)
  await assert.rejects(deleteTenant(d, A, { requestedBy: 'test', policy: { suppressions: 'retain', retainTables: ['app_leases'] } }), /not a tenant-scoped table/)
  const bBefore = snapshotSqlite(db, B)
  const t = await deleteTenant(d, A, { policy: POLICY, requestedBy: 'operator (synthetic test)', now: NOW })
  assert.equal(t.state, 'completed'); assert.deepEqual(JSON.parse(t.retained!), { evidence_purge_audit: 1, suppressions: 1 })
  const after = snapshotSqlite(db, A)
  assert.deepEqual(emptyExcept(after, ['suppressions']), [], 'every other table is empty for the deleted tenant')
  assert.notEqual(after.suppressions, '[]', 'opt-outs retained by policy')
  assert.deepEqual(leftovers(db, 'ta', ['suppressions']), [], 'no row anywhere still carries the deleted tenant (orphans included)')
  assert.ok(leftovers(db, 'tb', []).length > 50, 'the scan does see data: the other tenant is everywhere')
  assert.deepEqual(snapshotSqlite(db, B), bBefore, 'the other tenant is byte-identical')
  assert.equal(db.prepare('SELECT count(*) AS n FROM organizations WHERE id = ?').pluck().get(A), 0, 'the workspace row is gone')
  assert.equal(db.prepare('SELECT count(*) AS n FROM organizations WHERE id = ?').pluck().get(B), 1)
  assert.throws(() => db.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'again', 'personal', ?, 1)").run(A, A), /tenant deleted/)
  // re-running a completed deletion changes nothing
  assert.equal((await deleteTenant(d, A)).state, 'completed'); assert.deepEqual(snapshotSqlite(db, B), bBefore)
  // erasing opt-outs too, when the policy says so
  const db2 = fixture()
  await deleteTenant(sqliteDb(db2), A, { policy: { suppressions: 'erase' }, requestedBy: 'test', now: NOW })
  assert.deepEqual(emptyExcept(snapshotSqlite(db2, A), []), [])
  assert.deepEqual(leftovers(db2, 'ta', []), [])
})

test('no recreation: late inserts for the deleted tenant, under its deleted parents, or an in-flight scan finishing are refused', async () => {
  const db = fixture(), d = sqliteDb(db)
  // A has a scan running when the deletion starts
  const job = await createQueryJob(d, A, { query: 'in flight' }, NOW)
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?").run(NOW, job)
  const oldJob = db.prepare('SELECT id FROM scan_jobs WHERE user_id = ? AND id <> ?').get(A, job) as { id: string }
  await deleteTenant(d, A, { policy: POLICY, requestedBy: 'test', now: NOW })
  // the in-flight scan finishes after the deletion: its leads cannot come back
  const lead = { name: 'Owner', company: 'Late Co', contact: null, signal: 's', source_url: 'https://late.example.test/x', score: 50, evidence_excerpt: 'late', event_date: null, date_status: null, retrieved_at: NOW, confidence: 50, dedup_key: 'late', fit: 3, intent: 3, action: 3, why: 'w', signal_kind: 'other', source_kind: 'company_site' }
  await finishJob(d, { id: job, attempts: 1 }, { status: 'done', error: null, leads: [lead as never], candidates: 1, dropped: {}, now: NOW + 60 }).catch(() => {})
  assert.equal((db.prepare("SELECT count(*) AS n FROM leads WHERE company = 'Late Co'").get() as { n: number }).n, 0, 'no lead from the in-flight scan')
  for (const [sql, args] of [
    ["INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('late-job', ?, 'x', 'y', 'z')", [A]],
    ["INSERT INTO leads (id, scan_job_id, company, source_url) VALUES ('late-lead', ?, 'Late', 'https://late.example.test')", [oldJob.id]],
    ["INSERT INTO suppressions (tenant_id, email, reason) VALUES (?, 'new@x.example', 'manual')", [A]],
    ["INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'again@x.example', 'x', 'y')", [A]],
  ] as [string, unknown[]][]) assert.throws(() => db.prepare(sql).run(...args), /tenant deleted/, sql)
  assert.deepEqual(emptyExcept(snapshotSqlite(db, A), ['suppressions']), [])
  // the other tenant is unaffected
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('b-job', ?, 'x', 'y', 'z')").run(B)
})

test('retryable: staged steps, a failed step rolls back and resumes from the last completed state', async () => {
  const db = fixture(), d = sqliteDb(db)
  let t = await deleteTenant(d, A, { policy: POLICY, requestedBy: 'test', now: NOW, until: 'revoked' })
  assert.equal(t.state, 'revoked')
  const mid = snapshotSqlite(db, A)
  for (const c of ['sessions', 'gmail_accounts', 'tenant_llm_keys', 'tenant_connectors', 'oauth_identities', 'oauth_states']) assert.equal(mid[c], '[]', `${c} revoked first`)
  assert.notEqual(mid.leads, '[]', 'data not yet erased')
  // the erase step fails part-way (a store error): nothing of that step is applied
  db.exec("CREATE TRIGGER fail_erase BEFORE DELETE ON scan_jobs BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;")
  await assert.rejects(deleteTenant(d, A), /simulated failure/)
  t = (await tombstone(d, A))!
  assert.equal(t.state, 'cancelled')
  assert.notEqual(snapshotSqlite(db, A).leads, '[]', 'the failed step rolled back as a whole')
  db.exec('DROP TRIGGER fail_erase')
  assert.equal((await deleteTenant(d, A)).state, 'completed', 'resumed without the policy being given again')
  assert.deepEqual(emptyExcept(snapshotSqlite(db, A), ['suppressions']), [])
})

test('restored backup: the deletion is re-applied from the off-database ledger before the store serves', async () => {
  const file = path.join(T, 'live.db'), backup = path.join(T, 'backup.db')
  const db = fixture(file)
  await db.backup(backup) // taken before the deletion
  const bBefore = snapshotSqlite(db, B)
  const t = await deleteTenant(sqliteDb(db), A, { policy: POLICY, requestedBy: 'operator (synthetic test)', now: NOW })
  const ledger = [tombstoneLedgerEntry(t)]
  assert.ok(!ledger[0].includes('ta~'), 'the ledger line carries no tenant data')
  db.close()
  // restore: the old copy has A's data back and no tombstone
  const restored = new Database(backup); migrateAllSqlite(restored)
  assert.notEqual(snapshotSqlite(restored, A).leads, '[]')
  assert.equal(await tombstone(sqliteDb(restored), A), undefined)
  // the other tenant as the restored store holds it (its migrations ran again on open), before the re-application
  const bRestored = snapshotSqlite(restored, B)
  assert.deepEqual(await reapplyTombstones(sqliteDb(restored), ledger, NOW + 3600), [{ tenant: A, state: 'completed' }])
  assert.deepEqual(emptyExcept(snapshotSqlite(restored, A), ['suppressions']), [])
  assert.deepEqual(leftovers(restored, 'ta', ['suppressions']), [])
  assert.deepEqual(snapshotSqlite(restored, B), bRestored, 'the re-applied deletion did not touch the other tenant')
  assert.deepEqual(Object.keys(snapshotSqlite(restored, B)), Object.keys(bBefore))
  assert.throws(() => restored.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('x', ?, 'x', 'y', 'z')").run(A), /tenant deleted/)
  restored.close()
})

test('shared workspaces are refused, never guessed: a team workspace, other members, a founder in another workspace', async () => {
  const cases: [string, (db: Database.Database) => void, RegExp][] = [
    ['team', db => db.prepare("UPDATE organizations SET kind = 'team' WHERE id = ?").run(A), /team workspaces cannot be deleted yet/],
    ['member', db => db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'viewer', 1)").run(A, B), /other members/],
    ['elsewhere', db => db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'viewer', 1)").run(B, A), /founder belongs to another workspace/],
  ]
  for (const [name, setup, why] of cases) {
    const db = fixture(); setup(db)
    const before = snapshotSqlite(db, A)
    await assert.rejects(deleteTenant(sqliteDb(db), A, { policy: POLICY, requestedBy: 'test' }), why, name)
    assert.equal(await tombstone(sqliteDb(db), A), undefined, `${name}: no tombstone`)
    assert.deepEqual(snapshotSqlite(db, A), before, `${name}: nothing changed`)
  }
})

// Retention cannot be silently broken by a cascade (review hold on 9cccf1d): a retained table whose parent, or a table
// it references with ON DELETE CASCADE / SET NULL, would be deleted is refused before anything happens; a satisfiable
// retention keeps every retained row byte-identical.
test('retention closure: dependent-table retention without its parent is refused with no effects', async () => {
  for (const [retainTables, why] of [
    [['lead_sources'], /lead_sources cannot be retained without leads/],                       // the review's reproduction
    [['leads'], /leads cannot be retained without scan_jobs/],                                  // middle of the chain
    [['commenter_batches'], /commenter_batches\.job_id references scan_jobs ON DELETE SET NULL/], // would rewrite retained rows
  ] as [string[], RegExp][]) {
    const db = fixture(), before = snapshotSqlite(db, A)
    await assert.rejects(deleteTenant(sqliteDb(db), A, { policy: { suppressions: 'erase', retainTables }, requestedBy: 'test' }), why, retainTables.join())
    assert.equal(await tombstone(sqliteDb(db), A), undefined, 'no tombstone')
    assert.deepEqual(snapshotSqlite(db, A), before, 'nothing deleted')
    // the refusal leaves nothing behind: a satisfiable deletion afterwards completes
    assert.equal((await deleteTenant(sqliteDb(db), A, { policy: { suppressions: 'erase' }, requestedBy: 'test' })).state, 'completed')
  }
})

test('retention closure: a retained parent keeps its rows while its unretained children go; retained descendants are kept intact', async () => {
  const cases: { retain: string[]; kept: string[]; gone: string[] }[] = [
    { retain: ['scan_jobs'], kept: ['scan_jobs'], gone: ['leads', 'lead_sources', 'scan_source_runs', 'commenter_batches'] },
    { retain: ['scan_jobs', 'leads', 'lead_sources'], kept: ['scan_jobs', 'leads', 'lead_sources'], gone: ['scan_source_runs', 'scan_run_report'] },
    { retain: ['scan_jobs', 'commenter_batches'], kept: ['scan_jobs', 'commenter_batches'], gone: ['commenter_rows', 'leads'] },
  ]
  for (const c of cases) {
    const db = fixture(), before = snapshotSqlite(db, A), bBefore = snapshotSqlite(db, B)
    const t = await deleteTenant(sqliteDb(db), A, { policy: { suppressions: 'erase', retainTables: c.retain }, requestedBy: 'test' })
    assert.equal(t.state, 'completed', c.retain.join())
    const after = snapshotSqlite(db, A)
    for (const k of c.kept) { assert.notEqual(before[k], '[]', `${k} had rows`); assert.equal(after[k], before[k], `${k} retained byte-identical (${c.retain.join()})`) }
    for (const g of c.gone) assert.equal(after[g], '[]', `${g} deleted (${c.retain.join()})`)
    const retained = JSON.parse(t.retained!)
    for (const k of c.kept) assert.equal(retained[k], JSON.parse(before[k]).length, `${k} count recorded`)
    assert.deepEqual(snapshotSqlite(db, B), bBefore)
  }
})

test('retention closure: nothing that depends on a credential table, users or organizations can be retained', () => {
  const scope = new Map([['token_log', { table: 'token_log', how: 'direct' as const, col: 'tenant_id' }], ['gmail_accounts', { table: 'gmail_accounts', how: 'direct' as const, col: 'tenant_id' }]])
  const fks = [{ table: 'token_log', column: 'account', ref: 'gmail_accounts', onDelete: 'CASCADE' }]
  assert.match(retentionProblems(scope, fks, new Set(['token_log'])).join(), /token_log cannot be retained: .* gmail_accounts is always deleted/)
  assert.deepEqual(retentionProblems(scope, [{ ...fks[0], onDelete: 'NO ACTION' }], new Set(['token_log'])), [], 'a reference that does nothing on delete is no dependency')
})
