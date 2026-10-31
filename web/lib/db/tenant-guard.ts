// Schema machinery for the tenant deletion lifecycle (lib/tenant/lifecycle.ts, issue #359), like insertion-order.ts:
// the tombstone tables, and on every tenant-scoped table that exists when it runs (it runs after every other migration)
// a BEFORE INSERT guard and a BEFORE UPDATE OF <tenant column or parent key> guard. They refuse a row for a deleted
// tenant, or under one of its deleted parent rows, whether inserted or moved there by an update, so in-flight work or
// a late write cannot recreate erased data and no row can change hands into a deleted tenant. Postgres: lib/db/migrations/pg/0025_tenant_lifecycle.sql.
import type Database from 'better-sqlite3'
import type { Db } from './client.ts'
import { classify, type Scope } from '../tenant/scope.ts'
// A transient lock row, not data (the evidence purge gate exists only inside one transaction): no deletion guard.
export const UNGUARDED = new Set(['evidence_purge_gate'])
// Columns that name an account without being the row's tenant column (no foreign key): guarded against tombstoned
// tenants too, so a deleted account can neither be added to another workspace nor have a membership moved onto it
// (decision 9 in docs/TENANT-LIFECYCLE.md, which the deletion also re-checks before erasing).
export const ACCOUNT_COLUMNS: Record<string, string[]> = { memberships: ['member_id'] }

// Every table's columns on a live store, either engine (engine-specific SQL lives here, with the other schema machinery).
export async function tableColumns(db: Db): Promise<Map<string, string[]>> {
  const rows = db.kind === 'pg'
    ? await db.all<{ t: string; c: string }>("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position")
    : await db.all<{ t: string; c: string }>("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'")
  const cols = new Map<string, string[]>(); for (const r of rows) cols.set(r.t, [...(cols.get(r.t) ?? []), r.c])
  return cols
}

// Every foreign key on a live store, either engine: the referencing table and column, the referenced table, and what a
// delete of the referenced row does (CASCADE, SET NULL, ...), upper-cased.
export async function foreignKeys(db: Db): Promise<{ table: string; column: string; ref: string; onDelete: string }[]> {
  const rows = db.kind === 'pg'
    ? await db.all<{ t: string; c: string; r: string; d: string }>(`SELECT tc.table_name AS t, kcu.column_name AS c, ccu.table_name AS r, rc.delete_rule AS d
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`)
    : await db.all<{ t: string; c: string; r: string; d: string }>(`SELECT m.name AS t, f."from" AS c, f."table" AS r, f.on_delete AS d FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`)
  return rows.map(r => ({ table: r.t, column: r.c, ref: r.r, onDelete: String(r.d).toUpperCase() }))
}

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
  const hasOrganizations = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'organizations'").get()
  for (const g of guardTriggers(scopeOfSqlite(db).filter(s => !UNGUARDED.has(s.table)))) {
    if (g.table === 'organizations' && !hasOrganizations) continue
    db.exec(g.sql)
  }
}

// The guard triggers for a set of guarded tables, plus the tenant's own identity rows (users, organizations) and the
// account columns (ACCOUNT_COLUMNS), as SQLite DDL. The Postgres migration is the translation of these
// (scripts/pg-migrate/translate-schema.ts), so both engines carry the same guards. Two per guarded column: BEFORE
// INSERT, and BEFORE UPDATE OF the tenant column or parent key, so a row can neither be created for a tombstoned
// tenant or under a deleted parent, nor moved there by re-pointing its ownership (the invariant: ownership and parent
// keys never move under a tombstoned tenant or deleted parent). A parent key is refused when the parent row was
// deleted (tenant_tombstone_keys) and, while the deletion is still in progress or the parent is retained, when the
// parent row's own chain belongs to a tombstoned tenant. The UPDATE guard tests the row's old value too: a tombstoned
// tenant's row can no more be moved out to another tenant (its data would survive the erase under a new owner) than
// another tenant's row can be moved in; a SET that keeps the same value is allowed without the subqueries (the row does
// not move, and the per-row cost of the chain lookups is paid only when the key changes). Each trigger is dropped and
// recreated (as the translator does on Postgres), so a change to a guard's body reaches an existing store at its next
// start.
//
// Each guard body starts with one SELECT per tenant id the row names (NEW's, and OLD's for an update): on SQLite that
// is a no-op; the translator turns it into pg_advisory_xact_lock_shared(hashtext(<tenant id>)), held to the end of
// the writer's transaction. A deletion step takes the same key exclusively (lib/tenant/lifecycle.ts), so it waits for
// that tenant's in-flight writers only, and never for or against any other tenant's.
export function guardTriggers(scope: Scope[]): { name: string; table: string; sql: string }[] {
  const byTable = new Map(scope.map(s => [s.table, s]))
  // whether the row of `table` whose id is `ref` belongs to a tombstoned tenant, through its parent chain: one primary
  // key lookup per level joined to tenant_tombstones (an `IN (SELECT id FROM parent WHERE ...)` form scanned the whole
  // parent table per written row on Postgres; review of PR #455)
  const tombstonedRow = (table: string, ref: string, depth = 0): string | undefined => {
    const s = byTable.get(table)
    if (!s) return undefined
    const p = `p${depth}`
    if (s.how === 'direct') return `EXISTS (SELECT 1 FROM ${table} ${p} JOIN tenant_tombstones t${depth} ON t${depth}.deleted_tenant = ${p}.${s.col} WHERE ${p}.id = ${ref})`
    const up = tombstonedRow(s.parent, `${p}.${s.col}`, depth + 1)
    return up && `EXISTS (SELECT 1 FROM ${table} ${p} WHERE ${p}.id = ${ref} AND ${up})`
  }
  // the tenant id a row of `table` belongs to, as an expression over its columns prefixed by `pre` ('NEW.', 'OLD.', or
  // '' for a row of the parent table inside a subquery), through the parent chain
  const tenantId = (table: string, pre: string): string | undefined => {
    const s = byTable.get(table)
    if (!s) return undefined
    if (s.how === 'direct') return `${pre}${s.col}`
    const up = tenantId(s.parent, '')
    return up && `(SELECT ${up} FROM ${s.parent} WHERE id = ${pre}${s.col})`
  }
  const out: { name: string; table: string; sql: string }[] = []
  const ddl = (name: string, event: string, table: string, locks: string[], when: string) =>
    `DROP TRIGGER IF EXISTS ${name}; CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN ${locks.map(l => `SELECT ${l}; `).join('')}SELECT RAISE(ABORT, 'tenant deleted') WHERE ${when}; END;`
  // `deleted(row)` says whether the row's value of `col` (NEW or OLD) belongs to a tombstoned tenant; `tenant(row)` is
  // that tenant's id (the advisory lock key)
  const guard = (table: string, col: string, deleted: (row: 'NEW' | 'OLD') => string, tenant: (row: 'NEW' | 'OLD') => string, suffix = '') => {
    out.push({ name: `tomb_${table}${suffix}`, table, sql: ddl(`tomb_${table}${suffix}`, 'INSERT', table, [tenant('NEW')], deleted('NEW')) })
    out.push({ name: `tomb_upd_${table}${suffix}`, table, sql: ddl(`tomb_upd_${table}${suffix}`, `UPDATE OF ${col}`, table, [tenant('NEW'), tenant('OLD')], `NEW.${col} IS NOT OLD.${col} AND ((${deleted('NEW')}) OR (${deleted('OLD')}))`) })
  }
  const tenantOf = (col: string) => (row: string) => `EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = ${row}.${col})`
  const own = (col: string) => (row: string) => `${row}.${col}`
  for (const s of scope) {
    if (s.how === 'direct') { guard(s.table, s.col, tenantOf(s.col), own(s.col)); continue }
    guard(s.table, s.col, row => { const live = tombstonedRow(s.parent, `${row}.${s.col}`); return `EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = '${s.parent}' AND key = ${row}.${s.col})${live ? ` OR ${live}` : ''}` },
      row => tenantId(s.table, `${row}.`) ?? `${row}.${s.col}`)
  }
  for (const t of ['organizations', 'users']) guard(t, 'id', tenantOf('id'), own('id'))
  for (const [table, cols] of Object.entries(ACCOUNT_COLUMNS)) if (byTable.has(table)) for (const col of cols) guard(table, col, tenantOf(col), own(col), `_${col}`)
  return out
}
