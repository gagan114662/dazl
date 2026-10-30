// lib/tenant/ledger.ts and scripts/tenant-tombstones.mts (#359 part 3): the off-database tombstone ledger, its re-application
// to a RESTORED backup, and which backups may still hold erased tenants. Synthetic two-tenant stores in temp files only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { deleteTenant, tombstone } from '../lib/tenant/lifecycle.ts'
import { appendLedger, backupExposure, parseLedger, readLedger } from '../lib/tenant/ledger.ts'
import { seedTenantSqlite, snapshotSqlite } from './helpers/tenant-seed-sqlite.ts'

const web = fileURLToPath(new URL('../', import.meta.url))
const A = 'tenant-aaaa', B = 'tenant-bbbb'
function store(file: string) {
  const db = new Database(file); migrateAllSqlite(db)
  for (const [id, email] of [[A, 'a@acme.io'], [B, 'b@beta.io']]) db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'h', 's')").run(id, email)
  for (const [t, tag] of [[A, 'ta'], [B, 'tb']]) assert.deepEqual(seedTenantSqlite(db, t, tag).failed, {})
  for (const t of [A, B]) {
    db.prepare("INSERT OR REPLACE INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'w', 'personal', ?, 1)").run(t, t)
    db.prepare('DELETE FROM memberships WHERE tenant_id = ? OR member_id = ?').run(t, t)
    db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'owner', 1)").run(t, t)
  }
  db.prepare('DELETE FROM tenant_requests').run()
  return db
}
const cli = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/tenant-tombstones.mts', ...a], { cwd: web, encoding: 'utf8' })

test('ledger: only completed deletions, once per tenant, fsynced append, owner-only file, no tenant data', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-')); const file = path.join(dir, 'tombstones.jsonl')
  const db = store(':memory:'); const d = sqliteDb(db)
  const partial = await deleteTenant(d, A, { policy: { suppressions: 'retain' }, requestedBy: 'ops', until: 'revoked' })
  assert.throws(() => appendLedger(file, partial), /not completed/)
  const done = await deleteTenant(d, A, { policy: { suppressions: 'retain' }, requestedBy: 'ops' })
  assert.equal(appendLedger(file, done), 'appended'); assert.equal(appendLedger(file, done), 'already_ledgered')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const entries = readLedger(file)
  assert.equal(entries.length, 1); assert.equal(entries[0].deleted_tenant, A); assert.deepEqual(entries[0].policy, { suppressions: 'retain', retainTables: [] })
  assert.doesNotMatch(readFileSync(file, 'utf8'), /ta~|a@acme\.io/, 'no tenant data in the ledger')
  assert.throws(() => parseLedger('{"kind":"other"}\n'), /not a tenant tombstone/)
  assert.throws(() => parseLedger('nope\n'), /not JSON/)
})

test('restore: a backup from before the deletion comes back with the tenant; reapply (dry run, then confirmed) erases it again, B untouched', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-restore-'))
  const live = path.join(dir, 'app.db'), backup = path.join(dir, 'backup.db'), ledger = path.join(dir, 'tombstones.jsonl')
  const db = store(live)
  const bBefore = snapshotSqlite(db, B)
  db.pragma('wal_checkpoint(TRUNCATE)'); copyFileSync(live, backup) // the nightly backup, taken before the deletion
  const t = await deleteTenant(sqliteDb(db), A, { policy: { suppressions: 'erase' }, requestedBy: 'ops-alex' })
  appendLedger(ledger, t); db.close()
  // check: the live store's deletions are all ledgered
  let r = cli('check', '--db', live, '--ledger', ledger); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).missing, [])
  writeFileSync(path.join(dir, 'empty.jsonl'), '')
  r = cli('check', '--db', live, '--ledger', path.join(dir, 'empty.jsonl')); assert.equal(r.status, 1); assert.deepEqual(JSON.parse(r.stdout).missing, [A])
  // the restored copy has A's rows and no tombstone
  const restoredCount = () => { const x = new Database(backup, { readonly: true }); const n = (x.prepare('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?').get(A) as { n: number }).n; x.close(); return n }
  assert.equal(restoredCount(), 1)
  r = cli('reapply', '--db', backup, '--ledger', ledger); assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { dry_run: true, missing: [A], already: [] }); assert.equal(restoredCount(), 1, 'dry run changed nothing')
  r = cli('reapply', '--db', backup, '--ledger', ledger, '--confirm'); assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).reapplied, [{ tenant: A, state: 'completed' }])
  assert.equal(restoredCount(), 0, 'erased again on the restored copy')
  const x = new Database(backup); assert.deepEqual(snapshotSqlite(x, B), bBefore, 'tenant B byte-identical'); assert.equal((await tombstone(sqliteDb(x), A))!.state, 'completed'); x.close()
  r = cli('reapply', '--db', backup, '--ledger', ledger); assert.deepEqual(JSON.parse(r.stdout), { dry_run: true, missing: [], already: [A] }, 'idempotent')
  // export rebuilds the ledger from the live store
  r = cli('export', '--db', live, '--out', path.join(dir, 'rebuilt.jsonl')); assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readLedger(path.join(dir, 'rebuilt.jsonl')).map(e => e.deleted_tenant), [A])
})

test('exposure: backups taken before a deletion may still hold the tenant; with an expiry, the old ones are overdue; without one, nothing is judged', () => {
  const D = 86400, now = 1_900_000_000
  const ledger = parseLedger(JSON.stringify({ kind: 'dazl-tenant-tombstone', deleted_tenant: A, requested_at: now - 10 * D, requested_by: 'ops', policy: {} }) + '\n')
  const backups = [{ name: 'old.db', created_at: now - 40 * D }, { name: 'recent.db', created_at: now - 12 * D }, { name: 'after.db', created_at: now - 5 * D }]
  const none = backupExposure(ledger, backups, { now, expireDays: null })
  assert.deepEqual(none.exposures.map(e => [e.backup, e.erased_tenants, e.overdue]), [['old.db', [A], false], ['recent.db', [A], false], ['after.db', [], false]])
  assert.equal(none.overdue, 0); assert.match(none.policy, /no backup expiry decided/)
  const thirty = backupExposure(ledger, backups, { now, expireDays: 30 })
  assert.deepEqual(thirty.exposures.map(e => [e.backup, e.overdue]), [['old.db', true], ['recent.db', false], ['after.db', false]]); assert.equal(thirty.overdue, 1)
  // through the command, on create-backup style files with sidecars
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-exp-')), ledgerFile = path.join(dir, 'l.jsonl')
  writeFileSync(ledgerFile, JSON.stringify({ kind: 'dazl-tenant-tombstone', deleted_tenant: A, requested_at: Math.floor(Date.now() / 1000) - 10 * D, requested_by: 'ops', policy: {} }) + '\n')
  for (const [name, age] of [['dazl-backup-old.db', 40], ['dazl-backup-new.db', 2]] as const) {
    writeFileSync(path.join(dir, name), 'SQLite format 3'); writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ createdAt: new Date(Date.now() - age * D * 1000).toISOString() }))
  }
  let r = cli('exposure', '--ledger', ledgerFile, '--backups', dir); assert.equal(r.status, 0, r.stderr)
  r = cli('exposure', '--ledger', ledgerFile, '--backups', dir, '--expire-days', '30'); assert.equal(r.status, 1, 'an overdue backup still holding an erased tenant')
  assert.deepEqual(JSON.parse(r.stdout).exposures.filter((e: { overdue: boolean }) => e.overdue).map((e: { backup: string }) => e.backup), ['dazl-backup-old.db'])
  assert.equal(readFileSync(path.join(dir, 'dazl-backup-old.db'), 'utf8'), 'SQLite format 3', 'reported, never deleted')
})
