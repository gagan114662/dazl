import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { sqliteImporters } from './helpers/sqlite-import-inventory.ts'

test('the SQLite inventory finds direct dependencies and excludes engine and test code', t => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-imports-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'load/scenario.mts': "const sqlite = await import('better-sqlite3')",
    'ops/script.cjs': "const sqlite = require('better-sqlite3')",
    'web/lib/outreach/write.ts': "import type Database from 'better-sqlite3'",
    'web/lib/scan/read.ts': "export { default } from 'better-sqlite3'",
    'web/lib/scan/type.ts': "type DB = import('better-sqlite3').Database",
    'web/lib/scan/equal.ts': "import DB = require('better-sqlite3')",
    'web/lib/scan/comment.ts': "// import Database from 'better-sqlite3'",
    'web/lib/db/client.ts': "import Database from 'better-sqlite3'",
    'web/test/case.test.ts': "import Database from 'better-sqlite3'",
    'load/scenario.test.mjs': "import Database from 'better-sqlite3'",
  }
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  assert.deepEqual(sqliteImporters(root), [
    'load/scenario.mts', 'ops/script.cjs', 'web/lib/outreach/write.ts',
    'web/lib/scan/equal.ts', 'web/lib/scan/read.ts', 'web/lib/scan/type.ts',
  ])
})

test('direct better-sqlite3 dependencies outside the database layer can only decrease', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const baseline = new Set(readFileSync(new URL('./fixtures/sqlite-import-baseline.txt', import.meta.url), 'utf8').trim().split('\n'))
  const added = sqliteImporters(root).filter(file => !baseline.has(file))
  assert.deepEqual(added, [], 'New direct SQLite imports must use the Db/Tx interface instead')
})

test('affected CI selects the ratchet for a new source file with no consumers', t => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-import-ci-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'CI fixture')
  git('config', 'user.email', 'ci@invalid.test')
  mkdirSync(join(root, 'web/test'), { recursive: true })
  writeFileSync(join(root, 'web/test/sqlite-import-ratchet.test.ts'), 'export {}')
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  mkdirSync(join(root, 'ops'))
  writeFileSync(join(root, 'ops/new-adapter.cjs'), "const db = require('better-sqlite3')")
  git('add', '.')
  git('commit', '-qm', 'new source')
  const selector = fileURLToPath(new URL('../../.github/scripts/affected-tests.mjs', import.meta.url))
  assert.equal(execFileSync(process.execPath, [selector, base], { cwd: root, encoding: 'utf8' }).trim(),
    'test/sqlite-import-ratchet.test.ts')
})
