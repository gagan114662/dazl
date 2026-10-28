// Extracts the authoritative full SQLite schema by running every module's own
// migrate function against a throwaway DB, then dumping sqlite_master. This is
// the schema the production DB actually converges to (CREATE + ALTER migrations),
// not a hand-maintained copy.
import Database from 'better-sqlite3'
import { writeFileSync, rmSync } from 'node:fs'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

const out = process.env.EXTRACT_OUT || '/tmp/full-schema'
const dbPath = `${out}.db`
rmSync(dbPath, { force: true })
rmSync(`${dbPath}-wal`, { force: true })
rmSync(`${dbPath}-shm`, { force: true })

const db = new Database(dbPath)
migrateAllSqlite(db)

const objects = db.prepare(
  `SELECT type, name, tbl_name, sql FROM sqlite_master
   WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
   ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
).all() as { type: string; name: string; tbl_name: string; sql: string }[]

const tables = objects.filter(o => o.type === 'table')
const indexes = objects.filter(o => o.type === 'index')
const triggers = objects.filter(o => o.type === 'trigger')

writeFileSync(`${out}.sql`, objects.map(o => o.sql).join(';\n\n') + ';\n')
writeFileSync(`${out}.json`, JSON.stringify({
  tables: tables.map(t => t.name),
  indexes: indexes.map(i => ({ name: i.name, table: i.tbl_name })),
  triggers: triggers.map(t => ({ name: t.name, table: t.tbl_name })),
}, null, 2))

console.log(`tables: ${tables.length}, indexes: ${indexes.length}, triggers: ${triggers.length}`)
for (const t of triggers) console.log(`  trigger ${t.name} on ${t.tbl_name}`)
db.close()
