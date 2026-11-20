// Qodo finding on #1437: a changed nested fixture such as web/test/fixtures/gate-check/pass.test.mjs was emitted as-is by
// affected-tests.mjs, and web-ci's shard validator (top-level test files only) rejected it, failing both lanes.
// A nested test-tree change must map to the top-level test(s) that use it. Run: node --test '.github/scripts/*.test.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const select = fileURLToPath(new URL('./affected-tests.mjs', import.meta.url))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (cwd, ...args) => spawnSync(process.execPath, [select, ...args], { cwd, encoding: 'utf8' }).stdout.trim()
const SHARD_ENTRY = /^test\/[a-zA-Z0-9_.-]+\.test\.(ts|mjs)$/ // the exact web-ci shard validator

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dazl-affected-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'CI fixture'); git(cwd, 'config', 'user.email', 'ci@invalid.test')
  mkdirSync(join(cwd, 'web/test/fixtures/gate-check'), { recursive: true })
  writeFileSync(join(cwd, 'web/test/gate-check.test.ts'), "const FIX = ['test/fixtures/gate-check']")
  writeFileSync(join(cwd, 'web/test/other.test.ts'), "import '../lib/other.ts'")
  writeFileSync(join(cwd, 'web/test/fixtures/gate-check/pass.test.mjs'), 'export {}')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'base')
  return [cwd, git(cwd, 'rev-parse', 'HEAD')]
}

test('a fixture-only change selects the top-level test that uses it, never the nested fixture', t => {
  const [cwd, base] = repo(t)
  writeFileSync(join(cwd, 'web/test/fixtures/gate-check/pass.test.mjs'), 'export const changed = 1')
  git(cwd, 'commit', '-am', 'fixture only')
  const out = run(cwd, base, 'HEAD')
  assert.equal(out, 'test/gate-check.test.ts')
  for (const f of out.split(' ')) assert.match(f, SHARD_ENTRY, 'every emitted entry passes the shard validator')
})

test('a nested test-tree change nobody references falls back to ALL instead of an invalid entry', t => {
  const [cwd, base] = repo(t)
  mkdirSync(join(cwd, 'web/test/fixtures/orphan'), { recursive: true })
  writeFileSync(join(cwd, 'web/test/fixtures/orphan/x.test.mjs'), 'export {}')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'orphan fixture')
  assert.equal(run(cwd, base, 'HEAD'), 'ALL')
})

test('a changed top-level test still selects itself', t => {
  const [cwd, base] = repo(t)
  writeFileSync(join(cwd, 'web/test/other.test.ts'), "import '../lib/other.ts' // edit")
  git(cwd, 'commit', '-am', 'top-level test')
  assert.equal(run(cwd, base, 'HEAD'), 'test/other.test.ts')
})
