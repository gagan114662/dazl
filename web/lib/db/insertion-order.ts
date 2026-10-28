// Insertion order that both engines keep (docs/PLATFORM.md "Postgres cutover"). SQLite's rowid gave these tables an
// implicit insertion order that same-second ties relied on; Postgres has none. insert_seq makes it a column:
//   - SQLite: backfilled from rowid, then an AFTER INSERT trigger gives each new row max(insert_seq) + 1. max rather than
//     rowid, so the order stays increasing after a copy back from Postgres (whose values can run ahead of rowid). Only
//     rows inserted without a value are stamped; a copied row keeps the value it brings.
//   - Postgres: a sequence default (lib/db/migrations/pg/0010_insertion_order.sql; translate-schema.ts maps the SQLite
//     trigger to it). lib/db/copy-store.ts moves the sequence past the copied values.
// Each table's own migration (migrateScan, migrateOutreach, migrateConnectors) calls this for its tables, so any store
// that has the table has the column; migrateAllSqlite and getScanDb call it once more for all four.
// Idempotent: safe on every start, on a fresh store and on an existing one.
import type Database from 'better-sqlite3'

export const INSERTION_ORDER_TABLES = ['scan_jobs', 'leads', 'outreach_messages', 'lead_enrichments'] as const

export function migrateInsertionOrder(db: Database.Database, tables: readonly (typeof INSERTION_ORDER_TABLES)[number][] = INSERTION_ORDER_TABLES): void {
  for (const t of tables) {
    const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(t) as { name: string }[]
    if (cols.length === 0) continue // the owning module's migration has not run on this handle
    db.transaction(() => {
      if (!cols.some(c => c.name === 'insert_seq')) db.exec(`ALTER TABLE ${t} ADD COLUMN insert_seq INTEGER`)
      db.exec(`UPDATE ${t} SET insert_seq = rowid WHERE insert_seq IS NULL`)
      db.exec(`CREATE INDEX IF NOT EXISTS ${t}_insert_seq_idx ON ${t} (insert_seq)`)
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_insert_seq AFTER INSERT ON ${t} WHEN NEW.insert_seq IS NULL BEGIN UPDATE ${t} SET insert_seq = (SELECT coalesce(max(insert_seq), 0) + 1 FROM ${t}) WHERE rowid = NEW.rowid; END`)
    })()
  }
}
