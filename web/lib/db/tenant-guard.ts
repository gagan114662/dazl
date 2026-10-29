// Schema machinery for the tenant deletion lifecycle (lib/tenant/lifecycle.ts, issue #359), like insertion-order.ts:
// the tombstone tables, and a BEFORE INSERT guard on every tenant-scoped table that exists when it runs (it runs after
// every other migration). The guard refuses a row for a deleted tenant, or under one of its deleted parent rows, so
// in-flight work or a late write cannot recreate erased data. Postgres: lib/db/migrations/pg/0015_tenant_lifecycle.sql.
import type Database from 'better-sqlite3'
import { classify, UNGUARDED, type Scope } from '../tenant/lifecycle.ts'

function scopeOfSqlite(db: Database.Database): Scope[] {
  const rows = db.prepare("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'").all() as { t: string; c: string }[]
  const cols = new Map<string, string[]>(); for (const r of rows) cols.set(r.t, [...(cols.get(r.t) ?? []), r.c])
  return classify(cols)
}

export function migrateTenantLifecycle(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_tombstones (
      deleted_tenant TEXT PRIMARY KEY,
      requested_at   INTEGER NOT NULL,
      requested_by   TEXT NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 200),
      state          TEXT NOT NULL CHECK (state IN ('requested','revoked','cancelled','erased','completed')),
      policy         TEXT NOT NULL,
      retained       TEXT,
      completed_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS tenant_tombstone_keys (
      deleted_tenant TEXT NOT NULL,
      tbl            TEXT NOT NULL,
      key            TEXT NOT NULL,
      PRIMARY KEY (tbl, key)
    );
  `)
  // the recreation guard on every tenant-scoped table that exists now (this runs after every other migration)
  for (const s of scopeOfSqlite(db)) {
    if (UNGUARDED.has(s.table)) continue
    const name = `tomb_${s.table}`
    const when = s.how === 'direct'
      ? `EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.${s.col})`
      : `EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = '${s.parent}' AND key = NEW.${s.col})`
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE INSERT ON ${s.table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'tenant deleted'); END;`)
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS tomb_users BEFORE INSERT ON users WHEN EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.id) BEGIN SELECT RAISE(ABORT, 'tenant deleted'); END;`)
}
