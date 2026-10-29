// scripts/migration-gate.mts against tiny synthetic "releases" (a sqlite-migrations.ts and a staging seed each), so
// every way a migration can damage the previous release's data is proved to fail the gate, not just lost rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))
const T = mkdtempSync(path.join(tmpdir(), 'migration-gate-test-'))
test.after(() => rmSync(T, { recursive: true, force: true }))

const BASE = `db.exec("CREATE TABLE IF NOT EXISTS demo (id TEXT PRIMARY KEY, value TEXT)")`
function release(name: string, migrate: string): string {
  const dir = path.join(T, name)
  mkdirSync(path.join(dir, 'lib/db'), { recursive: true }); mkdirSync(path.join(dir, 'scripts'))
  symlinkSync(path.join(web, 'node_modules'), path.join(dir, 'node_modules'))
  writeFileSync(path.join(dir, 'lib/db/sqlite-migrations.ts'), `export function migrateAllSqlite(db) { ${migrate} }\n`)
  writeFileSync(path.join(dir, 'scripts/staging-seed.mts'), `export async function seedStaging(raw) {
  raw.prepare("INSERT INTO demo (id, value) VALUES ('synthetic', 'must-preserve'), ('second', 'kept')").run(); return { tenant: 't' } }\n`)
  return dir
}
function gate(prev: string, next: string) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(web, 'scripts/migration-gate.mts'), prev, next], { encoding: 'utf8', timeout: 60_000 })
  return { code: r.status, out: r.stdout + r.stderr }
}
const prev = release('prev', BASE)

test('a migration that adds a column and backfills only the new column passes', () => {
  const next = release('good', `${BASE}; if (!db.prepare("SELECT 1 FROM pragma_table_info('demo') WHERE name = 'extra'").get()) db.exec("ALTER TABLE demo ADD COLUMN extra TEXT"); db.exec("UPDATE demo SET extra = 'x' WHERE extra IS NULL")`)
  const r = gate(prev, next)
  assert.equal(r.code, 0, r.out); assert.match(r.out, /forward, re-run and rollback all hold/)
})

test('an in-place value change with the same row count fails (the review reproduction)', () => {
  const r = gate(prev, release('update', `${BASE}; db.exec("UPDATE demo SET value = 'destroyed'")`))
  assert.equal(r.code, 1); assert.match(r.out, /FAIL new release: migrate forward: .*demo \["synthetic"\]: value changed/)
})

test('delete and replace with the same row count fails', () => {
  const r = gate(prev, release('replace', `${BASE}; db.exec("DELETE FROM demo WHERE id = 'synthetic'"); db.exec("INSERT OR IGNORE INTO demo VALUES ('other', 'must-preserve')")`))
  assert.equal(r.code, 1); assert.match(r.out, /demo \["synthetic"\]: row missing/)
})

test('a dropped column fails', () => {
  const r = gate(prev, release('dropcol', `${BASE}; if (db.prepare("SELECT 1 FROM pragma_table_info('demo') WHERE name = 'value'").get()) db.exec("ALTER TABLE demo DROP COLUMN value")`))
  assert.equal(r.code, 1); assert.match(r.out, /column value dropped/)
})

test('a migration that is not idempotent fails on the second run', () => {
  const r = gate(prev, release('nonidem', `${BASE}; db.exec("INSERT INTO demo VALUES (lower(hex(randomblob(4))), 'again')")`))
  assert.equal(r.code, 1); assert.match(r.out, /FAIL new release: migrate again/)
})

test('a previous release whose own migration rewrites values written under the new schema fails the rollback', () => {
  // the new release adds rows; the previous release "normalises" every value on start: a rollback would corrupt data
  const oldRewrites = release('old-rewrites', `${BASE}; if (db.prepare("SELECT count(*) AS n FROM demo").get().n > 2) db.exec("UPDATE demo SET value = upper(value)")`)
  writeFileSync(path.join(oldRewrites, 'scripts/staging-seed.mts'), `export async function seedStaging(raw) {
  raw.prepare("INSERT INTO demo (id, value) VALUES ('synthetic', 'MUST-PRESERVE'), ('second', 'KEPT')").run(); return { tenant: 't' } }\n`)
  const next = release('adds-row', `${BASE}; db.exec("INSERT OR IGNORE INTO demo VALUES ('added', 'lower')")`)
  const r = gate(oldRewrites, next)
  assert.equal(r.code, 1); assert.match(r.out, /FAIL rollback: .*demo \["added"\]: value changed/)
})
