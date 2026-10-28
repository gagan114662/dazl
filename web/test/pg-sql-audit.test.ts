// Postgres-readiness audit (lib/db/sql-audit.ts, docs/PLATFORM.md "Postgres cutover"). Holds the app to
// lib/db/pg-port-status.ts in both directions:
//   - a module that starts using the raw SQLite handle, or a statement Postgres rejects, fails (no new SQLite-only code);
//   - a module ported to Db, or a statement fixed, fails until its line is updated (the manifest only shrinks).
// Every statement on the Db layer, and every Postgres-native query(), must PREPARE on Postgres: that code already claims
// to run there.
// Regenerate after a port: DAZL_AUDIT_PG_URL=... node --experimental-strip-types scripts/pg-migrate/sql-audit.mts --write
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import pg from 'pg'
import { sqlInventory, sqlSitesIn, rawSqliteModules, pgRejects, portStatus, toPgParams, isSqliteAdmin, insertionOrderUsers } from '../lib/db/sql-audit.ts'
import { RAW_SQLITE_MODULES, PG_INSERTION_ORDER_GAPS } from '../lib/db/pg-port-status.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(import.meta.dirname, '..')
const REGEN = 'regenerate: node --experimental-strip-types scripts/pg-migrate/sql-audit.mts --write'

test('sql audit: finds raw and Db statements, constants and runtime-built SQL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sql-audit-'))
  try {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'm.ts'), `
      const COLS = 'id, name'
      const Q = \`SELECT \${COLS} FROM users WHERE id = ?\`
      export function f(h: any, db: any, t: any, pool: any, where: string) {
        h.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run('x')
        h.prepare(Q).get('x')
        h.exec('CREATE TABLE IF NOT EXISTS z (a TEXT)')
        db.get("SELECT 1 AS x FROM users WHERE email = @email")
        t.run(\`UPDATE users SET name = ? WHERE \${where}\`)
        pool.query('SELECT id FROM users WHERE id = $1', ['x'])
        new Map().get('a key, not a statement')
        /re/.exec('not sql')
      }`)
    const s = sqlSitesIn(join(dir, 'lib', 'm.ts'), dir)
    assert.deepEqual(s.map(x => [x.api, x.dynamic, x.sql.slice(0, 22)]), [
      ['raw', false, 'INSERT OR IGNORE INTO '],
      ['raw', false, 'SELECT id, name FROM u'],
      ['raw', false, 'CREATE TABLE IF NOT EX'],
      ['db', false, 'SELECT 1 AS x FROM use'],
      ['db', true, 'UPDATE users SET name '],
      ['pg', false, 'SELECT id FROM users W'],
    ])
    assert.equal(isSqliteAdmin(s[2].sql), true)
    assert.deepEqual(rawSqliteModules(dir), ['lib/m.ts'])
  } finally { rmSync(dir, { recursive: true }) }
})

test('sql audit: SQLite placeholders become Postgres $n, outside quotes; a named parameter keeps its number', () => {
  assert.equal(toPgParams("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?"), "SELECT * FROM t WHERE a = $1 AND b = '?' AND c = $2")
  assert.equal(toPgParams('UPDATE t SET a = @a, b = :b WHERE id = @id AND a <> @a'), 'UPDATE t SET a = $1, b = $2 WHERE id = $3 AND a <> $1')
  assert.equal(toPgParams('SELECT ?2, ?1, ?2'), 'SELECT $1, $2, $1')
  assert.equal(toPgParams("SELECT x::text, '@a' FROM t -- ?\n WHERE y = $id"), "SELECT x::text, '@a' FROM t -- ?\n WHERE y = $1")
})

test('every module on the raw SQLite handle is in lib/db/pg-port-status.ts, and only those', () => {
  const raw = rawSqliteModules(root)
  const listed = Object.keys(RAW_SQLITE_MODULES)
  const added = raw.filter(f => !listed.includes(f))
  const ported = listed.filter(f => !raw.includes(f))
  assert.deepEqual(added, [], `new code on the raw SQLite handle: write it on the Db layer (lib/db/client.ts) instead. ${REGEN} only if it truly cannot be`)
  assert.deepEqual(ported, [], `these no longer use the raw SQLite handle: remove their lines (${REGEN})`)
})

test('every module ordering ties by insertionOrder() is listed as a Postgres insertion-order gap, and only those', () => {
  assert.deepEqual(insertionOrderUsers(root), PG_INSERTION_ORDER_GAPS, REGEN)
})

test('Postgres PREPAREs every statement on the Db layer, and rejects no more raw statements than the manifest says', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const pool = new pg.Pool({ connectionString: PG_URL!, max: 1, options: `-c search_path=${s.schema}` })
  try {
    await runPgMigrations(pool)
    const sites = sqlInventory(root)
    const c = await pool.connect()
    const rejects = await pgRejects(c, sites).finally(() => c.release())
    const show = (fs: typeof rejects) => fs.map(r => `\n  ${r.site.file}:${r.site.line} ${r.error}`).join('')
    const onDb = rejects.filter(r => r.site.api !== 'raw')
    assert.deepEqual(onDb.map(r => `${r.site.file}:${r.site.line}`), [], `Db-layer or Postgres-native SQL that Postgres rejects:${show(onDb)}`)
    const got = portStatus(rawSqliteModules(root), rejects)
    const diff = Object.keys({ ...got, ...RAW_SQLITE_MODULES }).filter(f => got[f] !== RAW_SQLITE_MODULES[f])
    assert.deepEqual(diff.map(f => `${f}: manifest ${RAW_SQLITE_MODULES[f]}, now ${got[f]}`), [],
      `Postgres-rejected statements changed:${show(rejects.filter(r => diff.includes(r.site.file)))}\n${REGEN}`)
  } finally { await pool.end(); await s.drop() }
})
