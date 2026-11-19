import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { createQueryJob, pinAdmittedStrictJob } from '../lib/scan/store.ts'

const names = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'strict_local_pin_%' ORDER BY name").all() as { name: string }[]).map(r => r.name)
const PIN_TRIGGERS = ['strict_local_pin_budget', 'strict_local_pin_handback', 'strict_local_pin_insert']
test('only a committed first pin initializes the local SQLite fence; ordinary bootstrap stays portable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strict-pin-schema-'))
  const filename = join(dir, 'scan.db')
  const db = new Database(filename)
  const reader = new Database(filename)
  try {
    db.pragma('journal_mode = WAL')
    migrateAllSqlite(db)
    assert.deepEqual(names(reader), [])
    db.prepare("INSERT INTO users (id,email,password_hash,salt,business_name,created_at) VALUES ('A','a@example.test','h','s','Example',1)").run()
    const raw = qaClaudeOnlyBudget(null)
    const create = (id: string) => createQueryJob(db, 'A', { id, query: 'Dental practices hiring in New York', runBudget: raw })
    const get = (id: string) => reader.prepare('SELECT status,attempts FROM scan_jobs WHERE id=?').get(id)

    // The missing funding row refuses the native claim after installing the triggers inside this transaction.
    assert.throws(() => db.transaction(() => { create('refused'); pinAdmittedStrictJob(db, 'A', 'refused', raw) }).immediate(), /could not claim/)
    assert.equal(get('refused'), undefined)
    assert.deepEqual(names(reader), [], 'both candidate insert and first DDL rolled back')

    db.prepare("INSERT INTO tenant_llm_keys (tenant_id,vendor,ciphertext,last4,validated_at,created_at) VALUES ('A','anthropic','stub','abcd',1,1)").run()
    assert.throws(() => db.transaction(() => {
      create('aborted')
      pinAdmittedStrictJob(db, 'A', 'aborted', raw)
      assert.deepEqual(names(db), PIN_TRIGGERS)
      assert.deepEqual(names(reader), [])
      assert.equal(get('aborted'), undefined)
      throw new Error('force admission rollback')
    }).immediate(), /force admission rollback/)
    assert.equal(get('aborted'), undefined)
    assert.deepEqual(names(reader), [])

    db.transaction(() => {
      create('first')
      pinAdmittedStrictJob(db, 'A', 'first', raw)
      assert.deepEqual(names(db), PIN_TRIGGERS)
      assert.deepEqual(names(reader), [])
      assert.equal(get('first'), undefined)
    }).immediate()
    assert.deepEqual(get('first'), { status: 'running', attempts: 1 })
    assert.deepEqual(names(reader), PIN_TRIGGERS)
    migrateAllSqlite(db)
    assert.deepEqual(names(reader), PIN_TRIGGERS)
    db.prepare("UPDATE scan_jobs SET status='pending' WHERE id='first'").run()
    assert.deepEqual(get('first'), { status: 'failed', attempts: 1 })
  } finally { reader.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('portable schema translator still refuses an unknown trigger, even with a strict-local-looking name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strict-pin-translation-'))
  try {
    const src = join(dir, 'input.sql')
    const portable = readFileSync(new URL('../scripts/pg-migrate/schema-sqlite-reference.generated.sql', import.meta.url), 'utf8')
    const translator = fileURLToPath(new URL('../scripts/pg-migrate/translate-schema.ts', import.meta.url))
    writeFileSync(src, portable + "\nCREATE TRIGGER strict_local_pin_unrecognized BEFORE UPDATE ON scan_jobs BEGIN SELECT RAISE(IGNORE); END;\n")
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', translator], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, SQLITE_SCHEMA: src, PG_SCHEMA_OUT: join(dir, 'pg.sql'), PG_SLICE_SCHEMA_OUT: join(dir, 'slice.sql'), PG_MIGRATION_OUT: join(dir, 'migration.sql') },
    })
    assert.equal(r.error, undefined)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /untranslated trigger shape remains/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
