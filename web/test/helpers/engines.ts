// Runs one test body on both stores: a fresh in-memory SQLite DB with every sqlite migration, and (when
// DAZL_TEST_PG_URL is set) a fresh Postgres schema with every PG migration, dropped afterwards. A module ported to the
// Db layer proves it behaves the same on both by putting its tests here.
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb, pgDb } from '../../lib/db/client.ts'
import type { Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './pg-test.ts'

// raw: the SQLite handle behind db (for helpers that seed or inspect the store directly); absent on Postgres.
export interface EngineCtx { db: Db; kind: Db['kind']; url?: string; schema?: string; raw?: Database.Database }

export function bothEngines(name: string, body: (c: EngineCtx) => Promise<void>, opts: { pgMax?: number } = {}): void {
  test(`[sqlite] ${name}`, async () => {
    const raw = new Database(':memory:')
    migrateAllSqlite(raw)
    const db = sqliteDb(raw)
    try { await body({ db, kind: 'sqlite', raw }) } finally { await db.close() }
  })
  test(`[pg] ${name}`, { skip: pgSkip }, async () => {
    const s = await freshSchema()
    const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: opts.pgMax })
    try {
      await runPgMigrations(db.pool)
      await body({ db, kind: 'pg', url: PG_URL, schema: s.schema })
    } finally { await db.close(); await s.drop() }
  })
}
