import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const selector = fileURLToPath(new URL('./affected-tests.mjs', import.meta.url))
const inventoryTests = [
  'legal-policy.test.ts', 'scan-spend-cap-paths.test.ts', 'paid-paths-guarded.test.ts',
  'pg-sql-audit.test.ts', 'tenant-isolation-manifest.test.ts',
]

test('a new lib or app file selects repository inventories even without any test imports', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'dazl-inventory-selection-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'CI fixture')
  git('config', 'user.email', 'ci@invalid.test')
  mkdirSync(join(cwd, 'web/test'), { recursive: true })
  for (const name of inventoryTests) writeFileSync(join(cwd, 'web/test', name), 'export {}')
  git('add', '.')
  git('commit', '-qm', 'base')
  for (const directory of ['docs', 'web/lib', 'web/app']) {
    const base = git('rev-parse', 'HEAD')
    mkdirSync(join(cwd, directory), { recursive: true })
    writeFileSync(join(cwd, directory, 'new-adapter.ts'), 'export {}')
    git('add', '.')
    git('commit', '-qm', 'new file')
    const result = execFileSync(process.execPath, [selector, base], { cwd, encoding: 'utf8' }).trim()
    assert.equal(result, directory === 'docs' ? 'NONE' : inventoryTests.map(name => `test/${name}`).sort().join(' '), directory)
  }
})
