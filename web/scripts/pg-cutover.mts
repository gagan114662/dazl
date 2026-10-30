// Postgres cutover tool (docs/PLATFORM.md "Postgres cutover"). Operator-run, never by the app.
//   plan     --from <app.db | postgres://...> [--to <...>] [--tenants]   dry run: row counts per table (and per tenant),
//                                                                       the target's state and what copy would do; writes nothing
//   copy     --from <app.db> --to <postgres://...> [--rehearsal]          migrate the target, copy every table, verify
//   verify   --from <...> --to <...>                                     compare row counts and content checksums
//   rollback --from <postgres://...> --to <new.db>                       copy Postgres back into a new SQLite file, verify
// A SQLite source is opened read-only. copy is idempotent: re-run after it finished, it finds the same rows and writes
// nothing; a target holding anything else is refused. Copying into Postgres for the real cutover is refused while
// lib/db/pg-port-status.ts lists modules still on the raw SQLite handle (they would keep reading and writing the file):
// pass --rehearsal to copy anyway for a rehearsal. Exit codes: 0 done/matching, 1 stores differ, 2 usage, 3 refused.
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { sqliteDb, pgDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { copyStore, compareStores, storeCounts, CopyRefused } from '../lib/db/copy-store.ts'
import { RAW_SQLITE_MODULES } from '../lib/db/pg-port-status.ts'

const [cmd, ...rest] = process.argv.slice(2)
const arg = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }
const flag = (name: string) => rest.includes(`--${name}`)
const from = arg('from'), to = arg('to')
const isPg = (s: string) => /^postgres(ql)?:\/\//.test(s)
const shown = (s: string) => isPg(s) ? s.replace(/\/\/[^@/]*@/, '//***@') : s
const usage = (why: string) => { console.error(`${why}\nusage: pg-cutover.mts plan|copy|verify|rollback --from <app.db | postgres://...> --to <postgres://... | new.db> [--rehearsal] [--tenants]`); process.exit(2) }
if (!['plan', 'copy', 'verify', 'rollback'].includes(cmd ?? '') || !from || (cmd !== 'plan' && !to)) usage('missing command, --from or --to')
if (cmd === 'copy' && (isPg(from!) || !isPg(to!))) usage('copy goes from the SQLite file to Postgres; the way back is rollback')
if (cmd === 'rollback' && (!isPg(from!) || isPg(to!))) usage('rollback goes from Postgres to a new SQLite file')

async function openSource(s: string): Promise<Db> {
  return isPg(s) ? pgDb({ connectionString: s, max: 2 }) : sqliteDb(new Database(s, { readonly: true, fileMustExist: true }))
}
// copy/rollback targets are prepared (migrated / created); plan and verify open the target as it is, read-only for SQLite.
async function openTarget(s: string): Promise<Db> {
  if (isPg(s)) {
    const db = pgDb({ connectionString: s, max: 2 })
    if (cmd === 'copy') await runPgMigrations(db.pool)
    return db
  }
  if (cmd !== 'rollback') return sqliteDb(new Database(s, { readonly: true, fileMustExist: true }))
  if (existsSync(s)) throw new CopyRefused(`${s} exists: a rollback target must be a new file`)
  const h = new Database(s)
  h.pragma('journal_mode = WAL')
  migrateAllSqlite(h)
  return sqliteDb(h)
}

const blockers = Object.keys(RAW_SQLITE_MODULES).length
const gate = `${blockers} modules still use the raw SQLite handle (lib/db/pg-port-status.ts); after a cutover they would keep using the file`
if (cmd === 'copy' && blockers > 0 && !flag('rehearsal')) {
  console.error(`refused: ${gate}.\nPass --rehearsal to copy for a rehearsal only.`)
  process.exit(3)
}

const src = await openSource(from!)
const dst = to ? await openTarget(to).catch(e => { console.error(`refused: ${(e as Error).message}`); process.exit(3) }) : undefined
try {
  if (cmd === 'plan') {
    const counts = await storeCounts(src)
    console.log(`source ${shown(from!)} (${src.kind}): dry run, nothing is written`)
    for (const c of counts) {
      console.log(`${c.table.padEnd(32)} ${String(c.rows).padStart(8)}${c.tenantColumn ? `  tenants ${Object.keys(c.byTenant).length}` : ''}`)
      if (flag('tenants')) for (const [t, n] of Object.entries(c.byTenant).sort()) console.log(`    ${c.tenantColumn}=${t}  ${n}`)
    }
    console.log(`total ${counts.reduce((n, c) => n + c.rows, 0)} rows in ${counts.length} tables`)
    if (dst) {
      const counted = await storeCounts(dst).catch(() => null)
      const targetRows = counted && counted.length ? counted : null // no tables: not migrated
      const filled = targetRows?.filter(c => c.rows > 0 && c.table !== 'work_queue_meta') ?? null
      const diffs = filled && filled.length ? await compareStores(src, dst) : []
      console.log(`target ${shown(to!)}: ${targetRows === null ? 'not migrated yet (copy migrates it)' : filled!.length === 0 ? 'empty: copy would write every table above'
        : diffs.length === 0 ? 'already holds exactly these rows: copy would write nothing' : `holds other rows: copy would refuse (${diffs.slice(0, 3).join('; ')})`}`)
    }
    console.log(blockers ? `cutover gate: closed, ${gate}` : 'cutover gate: open (no module left on the raw SQLite handle)')
    process.exitCode = 0
  } else {
    if (cmd !== 'verify') {
      const r = await copyStore(src, dst!)
      for (const t of r.tables) console.log(`${t.table.padEnd(32)} ${String(t.rows).padStart(8)}  sha256:${t.checksum.slice(0, 16)}`)
      if (r.skipped.length) console.log(`empty, not in the target (skipped): ${r.skipped.join(', ')}`)
      console.log(r.alreadyCopied ? `already copied: ${shown(to!)} holds exactly the source's rows; nothing written`
        : `copied ${r.tables.reduce((n, t) => n + t.rows, 0)} rows in ${r.tables.length} tables, ${shown(from!)} -> ${shown(to!)}, verified before commit`)
    }
    const diffs = await compareStores(src, dst!)
    for (const d of diffs) console.log(`DIFF ${d}`)
    console.log(diffs.length ? `${diffs.length} tables differ` : 'stores match: every table has the same row count and content checksum')
    process.exitCode = diffs.length ? 1 : 0
  }
} catch (e) {
  if (!(e instanceof CopyRefused)) throw e
  console.error(`refused: ${e.message}`)
  process.exitCode = 3
} finally { await src.close(); await dst?.close() }
