// #829 (part of #707): the personal-workspace migration for existing single-user tenants is idempotent and rolls
// back cleanly. The backfill runs in one transaction, so a failure part-way leaves no half-migrated user, and the
// migration is additive (new tables and rows only), so removing it leaves every pre-existing tenant row untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAuth } from '../lib/auth-db.ts'

const PRE = "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER, expires_at INTEGER NOT NULL)"

function preWorkspaceDb() {
  const raw = new Database(':memory:')
  raw.exec(PRE)
  raw.exec("INSERT INTO users (id, email, business_name, password_hash, salt, created_at) VALUES ('a', 'a@example.test', 'Acme', 'h', 's', 1), ('b', 'b@example.test', 'Bolt', 'h', 's', 2)")
  raw.exec("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', 'a', 1, 9999999999)")
  return raw
}
const snapshot = (raw: Database.Database) => ({
  users: raw.prepare('SELECT id, email, name, business_name, password_hash, salt, created_at FROM users ORDER BY id').all(),
  sessions: raw.prepare('SELECT id, user_id, created_at, expires_at FROM sessions ORDER BY id').all(),
})

test('#829 migration is idempotent: every existing single-user tenant gets exactly one personal workspace it owns', () => {
  const raw = preWorkspaceDb()
  const before = snapshot(raw)
  migrateAuth(raw); migrateAuth(raw); migrateAuth(raw)
  assert.deepEqual(raw.prepare('SELECT id, name, kind, created_by FROM organizations ORDER BY id').all(), [
    { id: 'a', name: 'Acme', kind: 'personal', created_by: 'a' },
    { id: 'b', name: 'Bolt', kind: 'personal', created_by: 'b' },
  ])
  assert.deepEqual(raw.prepare('SELECT tenant_id, member_id, role FROM memberships ORDER BY tenant_id').all(), [
    { tenant_id: 'a', member_id: 'a', role: 'owner' },
    { tenant_id: 'b', member_id: 'b', role: 'owner' },
  ])
  assert.deepEqual(snapshot(raw), before, 'existing user and session rows are not rewritten')
})

test('#829 rollback: a failure part-way through the backfill leaves no half-migrated tenant, and a rerun completes it', () => {
  const raw = preWorkspaceDb()
  migrateAuth(raw)
  // Undo the backfill rows so the next startup has to migrate both users again, then make tenant b's workspace fail.
  raw.exec('DELETE FROM memberships; DELETE FROM organizations')
  raw.exec("CREATE TRIGGER fail_b BEFORE INSERT ON organizations WHEN NEW.id = 'b' BEGIN SELECT RAISE(ABORT, 'boom'); END")
  assert.throws(() => migrateAuth(raw), /boom/)
  assert.equal(raw.prepare('SELECT count(*) AS n FROM memberships').get().n, 0, 'memberships rolled back with the failed backfill')
  assert.equal(raw.prepare('SELECT count(*) AS n FROM organizations').get().n, 0, 'organizations rolled back with the failed backfill')
  raw.exec('DROP TRIGGER fail_b')
  migrateAuth(raw)
  assert.deepEqual(raw.prepare('SELECT o.id, m.member_id, m.role FROM organizations o JOIN memberships m ON m.tenant_id = o.id ORDER BY o.id').all(), [
    { id: 'a', member_id: 'a', role: 'owner' },
    { id: 'b', member_id: 'b', role: 'owner' },
  ])
})

test('#829 rollback: removing the workspace tables leaves every pre-existing tenant row exactly as it was', () => {
  const raw = preWorkspaceDb()
  const before = snapshot(raw)
  migrateAuth(raw)
  raw.exec('DROP TABLE memberships; DROP TABLE organizations')
  assert.deepEqual(snapshot(raw), before)
})
