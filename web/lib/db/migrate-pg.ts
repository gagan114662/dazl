// Versioned Postgres migrations, run on deploy by scripts/db-migrate.mts (npm run db:migrate).
//
// - Files: lib/db/migrations/pg/NNNN_name.sql, applied in version order, each in its own transaction.
// - Ledger: dazl_schema_migrations(version, name, checksum, applied_at). An applied file whose checksum changed, or a
//   ledger version with no file (the DB is ahead of this code), stops the run before anything is applied.
// - Concurrency: the whole run holds a session advisory lock, so two instances deploying at once apply each migration
//   exactly once; the second waits, then finds nothing left to do.
// SQLite is unchanged: its tables are still created by each module's migrate*() at startup.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations', 'pg')
// Arbitrary fixed key; any other user of pg advisory locks in this app must pick a different one.
export const MIGRATE_LOCK_KEY = 7013420001

export interface Migration { version: number; name: string; sql: string; checksum: string }

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const list = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => {
    const m = f.match(/^(\d{4})_([a-z0-9_]+)\.sql$/)
    if (!m) throw new Error(`bad migration file name: ${f} (want NNNN_name.sql)`)
    const sql = readFileSync(path.join(dir, f), 'utf8')
    return { version: Number(m[1]), name: m[2], sql, checksum: createHash('sha256').update(sql).digest('hex') }
  })
  list.forEach((m, i) => { if (m.version !== i + 1) throw new Error(`migration versions must be 1..n with no gaps; found ${m.version} at position ${i + 1}`) })
  return list
}

export interface MigrateResult { applied: number[]; alreadyApplied: number[] }

export async function runPgMigrations(pool: pg.Pool, migrations: Migration[] = loadMigrations()): Promise<MigrateResult> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY])
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS dazl_schema_migrations (
        version BIGINT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
        applied_at BIGINT NOT NULL DEFAULT CAST(floor(extract(epoch from now())) AS BIGINT))`)
      const done = (await client.query('SELECT version, checksum FROM dazl_schema_migrations ORDER BY version')).rows as { version: string | number; checksum: string }[]
      const byVersion = new Map(migrations.map(m => [m.version, m]))
      for (const row of done) {
        const v = Number(row.version)
        const m = byVersion.get(v)
        if (!m) throw new Error(`database has migration ${v}, which this code does not know; refusing to run`)
        if (m.checksum !== row.checksum) throw new Error(`migration ${v} (${m.name}) changed after it was applied; add a new migration instead`)
      }
      const doneSet = new Set(done.map(r => Number(r.version)))
      const applied: number[] = []
      for (const m of migrations) {
        if (doneSet.has(m.version)) continue
        await client.query('BEGIN')
        try {
          await client.query(m.sql)
          await client.query('INSERT INTO dazl_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum])
          await client.query('COMMIT')
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          throw new Error(`migration ${m.version} (${m.name}) failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        applied.push(m.version)
      }
      return { applied, alreadyApplied: [...doneSet].sort((a, b) => a - b) }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]).catch(() => {})
    }
  } finally { client.release() }
}
