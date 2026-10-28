import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

// Regenerates the schema from the code's own sqlite migrate*() functions (extract-schema.ts -> translate-schema.ts)
// into a temp dir. A module that adds a table or column without regenerating fails here.
const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(path.join(tmpdir(), 'schema-'))
function regenerate() {
  const env = { ...process.env, EXTRACT_OUT: path.join(out, 'full'), SQLITE_SCHEMA: path.join(out, 'full.sql'), PG_SCHEMA_OUT: path.join(out, 'pg.sql'), PG_SLICE_SCHEMA_OUT: path.join(out, 'slice.sql'), PG_MIGRATION_OUT: path.join(out, 'migration.sql'), DB_PATH: path.join(out, 'full.db') }
  for (const s of ['extract-schema.ts', 'translate-schema.ts']) {
    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(root, 'scripts/pg-migrate', s)], { env, cwd: root, stdio: 'pipe' })
  }
}
regenerate()
const committed = (f: string) => readFileSync(path.join(root, f), 'utf8')
const fresh = (f: string) => readFileSync(path.join(out, f), 'utf8')
const HOW = 'regenerate: see web/lib/db/migrations/pg/README.md'

test('committed schema files match what the code generates', () => {
  assert.equal(committed('scripts/pg-migrate/schema-sqlite-reference.generated.sql'), fresh('full.sql'), `sqlite reference is stale; ${HOW}`)
  assert.equal(committed('scripts/pg-migrate/schema-full.generated.sql'), fresh('pg.sql'), `rehearsal schema is stale; ${HOW}`)
})

// Structural comparison, not file equality: once migrations are applied somewhere, 0001 is frozen and later schema
// changes arrive as new files, so "all migrations applied" must equal "today's translation" table by table.
async function describe(schema: string) {
  const c = new pg.Client({ connectionString: PG_URL })
  await c.connect()
  try {
    const q = async (sql: string) => (await c.query(sql, [schema])).rows.map(r => Object.values(r).join(' | ')).sort()
    return {
      columns: await q(`SELECT table_name, column_name, data_type, is_nullable, replace(coalesce(column_default, ''), $1 || '.', ''), is_identity FROM information_schema.columns WHERE table_schema = $1 AND table_name <> 'dazl_schema_migrations'`),
      constraints: await q(`SELECT r.relname, replace(pg_get_constraintdef(c.oid), $1 || '.', '') FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE c.connamespace = $1::regnamespace AND r.relname <> 'dazl_schema_migrations'`),
      indexes: await q(`SELECT tablename, replace(indexdef, $1 || '.', '') FROM pg_indexes WHERE schemaname = $1 AND tablename <> 'dazl_schema_migrations'`),
      triggers: await q(`SELECT event_object_table, trigger_name, event_manipulation, action_timing FROM information_schema.triggers WHERE trigger_schema = $1`),
      functions: await q(`SELECT p.proname, replace(pg_get_functiondef(p.oid), $1 || '.', '') FROM pg_proc p WHERE p.pronamespace = $1::regnamespace`),
    }
  } finally { await c.end() }
}

test('PG migrations produce exactly the schema the code generates today', { skip: pgSkip }, async () => {
  const a = await freshSchema(), b = await freshSchema()
  const pa = new pg.Pool({ connectionString: PG_URL, options: `-c search_path=${a.schema}` })
  const pb = new pg.Pool({ connectionString: PG_URL, options: `-c search_path=${b.schema}` })
  try {
    await runPgMigrations(pa)
    await pb.query(fresh('migration.sql'))
    const [da, db] = await Promise.all([describe(a.schema), describe(b.schema)])
    for (const k of Object.keys(da) as (keyof typeof da)[]) {
      assert.deepEqual(da[k], db[k], `${k} differ between applied migrations and the current code; add lib/db/migrations/pg/NNNN_*.sql (${HOW})`)
    }
    assert.ok(da.columns.length > 500)
  } finally { await pa.end(); await pb.end(); await a.drop(); await b.drop() }
})
