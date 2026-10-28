// Postgres cutover tool (docs/PLATFORM.md "Postgres cutover"). Operator-run, never by the app.
//   copy   --from <app.db | postgres://...> --to <postgres://... | new.db>   copy every table, verified, into an empty store
//   verify --from <...> --to <...>                                       compare row counts and content checksums
// A SQLite source is opened read-only. A Postgres target is migrated first; a SQLite target must be a new file.
// Copying into Postgres for the real cutover is refused while lib/db/pg-port-status.ts lists modules still on the raw
// SQLite handle (they would keep reading and writing the file): pass --rehearsal to copy anyway for a rehearsal.
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { sqliteDb, pgDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { copyStore, compareStores } from '../lib/db/copy-store.ts'
import { RAW_SQLITE_MODULES } from '../lib/db/pg-port-status.ts'

const [cmd, ...rest] = process.argv.slice(2)
const arg = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }
const from = arg('from'), to = arg('to')
const isPg = (s: string) => /^postgres(ql)?:\/\//.test(s)
const shown = (s: string) => isPg(s) ? s.replace(/\/\/[^@/]*@/, '//***@') : s
if (!['copy', 'verify'].includes(cmd ?? '') || !from || !to) {
  console.error('usage: pg-cutover.mts copy|verify --from <app.db | postgres://...> --to <postgres://... | new.db> [--rehearsal]')
  process.exit(2)
}

async function open(s: string, role: 'source' | 'target'): Promise<Db> {
  if (isPg(s)) {
    const db = pgDb({ connectionString: s, max: 2 })
    if (role === 'target' && cmd === 'copy') await runPgMigrations(db.pool)
    return db
  }
  if (role === 'source' || cmd === 'verify') return sqliteDb(new Database(s, { readonly: true, fileMustExist: true }))
  if (existsSync(s)) throw new Error(`${s} exists: a SQLite target must be a new file`)
  const h = new Database(s)
  h.pragma('journal_mode = WAL')
  migrateAllSqlite(h)
  return sqliteDb(h)
}

const blockers = Object.keys(RAW_SQLITE_MODULES).length
if (cmd === 'copy' && isPg(to) && blockers > 0 && !rest.includes('--rehearsal')) {
  console.error(`refused: ${blockers} modules still use the raw SQLite handle (lib/db/pg-port-status.ts); after a cutover they would keep using the file.\nPass --rehearsal to copy for a rehearsal only.`)
  process.exit(3)
}
const src = await open(from, 'source'), dst = await open(to, 'target')
try {
  if (cmd === 'copy') {
    const r = await copyStore(src, dst)
    for (const t of r.tables) console.log(`${t.table.padEnd(32)} ${String(t.rows).padStart(8)}  sha256:${t.checksum.slice(0, 16)}`)
    if (r.skipped.length) console.log(`empty, not in the target (skipped): ${r.skipped.join(', ')}`)
    console.log(`copied ${r.tables.reduce((n, t) => n + t.rows, 0)} rows in ${r.tables.length} tables, ${shown(from)} -> ${shown(to)}, verified before commit`)
  }
  const diffs = await compareStores(src, dst)
  for (const d of diffs) console.log(`DIFF ${d}`)
  console.log(diffs.length ? `${diffs.length} tables differ` : 'stores match: every table has the same row count and content checksum')
  process.exitCode = diffs.length ? 1 : 0
} finally { await src.close(); await dst.close() }
